const axios = require("axios");
const cron = require("node-cron");
const osonModel = require("../models/osonPharmacyModel");

// ─── OSON API Config ───────────────────────────────────────────────────────
const OSON_API_BASE = "http://134.98.139.47/api/POS";
const OSON_HEADERS = {
  accept: "application/json",
  UserName: "3@V0@davo",
  DeviceTypeId: "0",
};

const OSON_REGIONS = [
  "surxondaryo",
  "toshkent",
  "qashqadaryo",
  "namangan",
  "buxoro",
  "xorazm",
  "samarqand",
  "fargona",
  "sirdaryo",
  "jizzax",
  "andijon",
  "qoraqalpogiston-respublikasi",
  "toshkent-viloyati",
  "navoiy",
];

// ─── Davo API Config ───────────────────────────────────────────────────────
const DAVO_API_BASE = "https://api.davodelivery.uz/api";

// ─── Batch size for parallel TileInfo requests ────────────────────────────
const DETAIL_BATCH_SIZE = 50; // fetch 50 pharmacy details at once

// ─── State ─────────────────────────────────────────────────────────────────
let isSyncing = false;
let lastSyncAt = null;
let lastSyncError = null;
let savedDavoToken = null;

// Progress tracking
let progressCurrent = 0;
let progressTotal = 0;
let progressPhase = ""; // 'collecting' | 'syncing' | 'cleanup' | 'done'

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch all slugs from OSON for all regions in parallel (all regions at once)
 */
async function fetchAllOsonSlugs() {
  const allSlugs = new Set();

  const results = await Promise.allSettled(
    OSON_REGIONS.map((region) =>
      axios
        .get(`${OSON_API_BASE}/SlugList`, {
          params: { region },
          headers: OSON_HEADERS,
          timeout: 20000,
        })
        .then((res) => {
          if (res.data?.Succeeded && res.data?.Data?.Items) {
            console.log(
              `[OSON Sync] Region "${region}": ${res.data.Data.Items.length} pharmacies`
            );
            return res.data.Data.Items;
          }
          return [];
        })
    )
  );

  let failedRegions = 0;
  results.forEach((r) => {
    if (r.status === "fulfilled") {
      r.value.forEach((slug) => allSlugs.add(slug));
    } else {
      failedRegions++;
      console.error("[OSON Sync] Region fetch failed:", r.reason?.message);
    }
  });

  console.log(
    `[OSON Sync] Total unique slugs: ${allSlugs.size} (${failedRegions} regions failed)`
  );
  return allSlugs;
}

/**
 * Fetch pharmacy details from OSON TileInfo API (single)
 */
async function fetchOsonPharmacyDetail(slug) {
  try {
    const response = await axios.get(`${OSON_API_BASE}/TileInfo/${slug}`, {
      headers: OSON_HEADERS,
      timeout: 10000,
    });
    if (response.data?.Succeeded && response.data?.Data) {
      return response.data.Data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a batch of pharmacy details in parallel
 * @param {string[]} slugs
 * @returns {Map<string, object>} slug → detail
 */
async function fetchDetailBatch(slugs) {
  const results = await Promise.allSettled(
    slugs.map((slug) => fetchOsonPharmacyDetail(slug).then((d) => ({ slug, d })))
  );

  const map = new Map();
  results.forEach((r) => {
    if (r.status === "fulfilled" && r.value.d) {
      map.set(r.value.slug, r.value.d);
    }
  });
  return map;
}

/**
 * Fetch all connected pharmacy slugs from Davo API
 */
async function fetchDavoConnectedSlugs(davoToken) {
  try {
    const response = await axios.post(
      `${DAVO_API_BASE}/market/list`,
      { searchKey: "", page: 0, size: 10000, active: true },
      {
        headers: {
          authorization: `Bearer ${davoToken}`,
          "content-type": "application/json",
        },
        timeout: 20000,
      }
    );

    const list = response.data?.payload?.list || [];
    const slugSet = new Set();
    list.forEach((m) => { if (m.slug) slugSet.add(m.slug); });

    console.log(`[OSON Sync] Connected in Davo: ${slugSet.size}`);
    return slugSet;
  } catch (err) {
    console.error("[OSON Sync] Failed to fetch Davo list:", err.message);
    return new Set();
  }
}

// ─── Main Sync Function ────────────────────────────────────────────────────

async function runOsonSync(davoToken) {
  if (isSyncing) {
    console.log("[OSON Sync] Already running, skipping.");
    return { skipped: true };
  }

  isSyncing = true;
  lastSyncError = null;
  progressCurrent = 0;
  progressTotal = 0;
  progressPhase = "collecting";
  const startTime = Date.now();

  console.log("[OSON Sync] ====== Starting OSON Sync ======");

  try {
    // Step 1: Collect all OSON slugs (parallel by region)
    progressPhase = "collecting";
    const osonSlugs = await fetchAllOsonSlugs();

    // Step 2: Get Davo connected slugs
    const davoSlugs = await fetchDavoConnectedSlugs(davoToken);

    // Step 3: Get existing DB state
    const dbSlugsMap = await osonModel.getAllSlugsWithStatus();

    const stats = { inserted: 0, updated: 0, statusChanged: 0, deleted: 0, markedDeleted: 0, errors: 0 };

    // Step 4: Split OSON slugs into new vs existing
    const newSlugs = [];         // need TileInfo fetch
    const existingSlugs = [];    // already in DB, just update status

    for (const slug of osonSlugs) {
      if (dbSlugsMap.has(slug)) {
        existingSlugs.push(slug);
      } else {
        newSlugs.push(slug);
      }
    }

    // Set total progress (only new slugs need detail fetches)
    progressTotal = newSlugs.length + existingSlugs.length;
    progressPhase = "syncing";

    console.log(`[OSON Sync] New slugs: ${newSlugs.length}, Existing: ${existingSlugs.length}`);

    // ── Step 5a: Process EXISTING slugs in batches (status update only, fast) ──
    const EXISTING_BATCH = 250; // batch size for DB updates
    for (let i = 0; i < existingSlugs.length; i += EXISTING_BATCH) {
      const batch = existingSlugs.slice(i, i + EXISTING_BATCH);
      await Promise.allSettled(
        batch.map(async (slug) => {
          const currentDbStatus = dbSlugsMap.get(slug);
          const isConnected = davoSlugs.has(slug);
          const newStatus = isConnected ? "connected" : "not_connected";

          try {
            if (currentDbStatus !== newStatus) {
              await osonModel.updateStatus(slug, newStatus);
              stats.statusChanged++;
            } else {
              await osonModel.updateStatus(slug, currentDbStatus);
              stats.updated++;
            }
          } catch (err) {
            console.error(`[OSON Sync] Update error "${slug}":`, err.message);
            stats.errors++;
          }
          progressCurrent++;
        })
      );
    }

    // ── Step 5b: Process NEW slugs in batches of DETAIL_BATCH_SIZE (TileInfo fetch) ──
    for (let i = 0; i < newSlugs.length; i += DETAIL_BATCH_SIZE) {
      const batch = newSlugs.slice(i, i + DETAIL_BATCH_SIZE);

      // Fetch details for the whole batch in parallel
      const detailMap = await fetchDetailBatch(batch);

      // Save each to DB
      await Promise.allSettled(
        batch.map(async (slug) => {
          const detail = detailMap.get(slug);
          const newStatus = davoSlugs.has(slug) ? "connected" : "not_connected";

          if (detail) {
            try {
              await osonModel.upsertPharmacy(
                slug,
                {
                  name_ru: detail.NameRu,
                  name_uz: detail.NameUz,
                  parent_region_ru: detail.ParentRegionNameRu,
                  parent_region_uz: detail.ParentRegionNameUz,
                  region_ru: detail.RegionNameRu,
                  region_uz: detail.RegionNameUz,
                  address_ru: detail.AddressRu,
                  address_uz: detail.AddressUz,
                  landmark_ru: detail.LandmarkRu,
                  landmark_uz: detail.LandmarkUz,
                  latitude: detail.Latitude,
                  longitude: detail.Longitude,
                  phone: detail.Phone,
                  open_time: detail.OpenTime,
                  close_time: detail.CloseTime,
                  has_delivery: detail.HasDelivery,
                  is_verified: detail.IsVerified,
                  discount_percent: detail.DiscountPercent,
                  cashback_percent: detail.CashbackPercent,
                },
                newStatus
              );
              stats.inserted++;
            } catch (err) {
              console.error(`[OSON Sync] Upsert error "${slug}":`, err.message);
              stats.errors++;
            }
          } else {
            // No detail returned — insert minimal record
            try {
              await osonModel.upsertPharmacy(slug, {}, newStatus);
              stats.inserted++;
            } catch (err) {
              stats.errors++;
            }
          }
          progressCurrent++;
        })
      );

      const pct = Math.round((progressCurrent / progressTotal) * 100);
      console.log(
        `[OSON Sync] Progress: ${progressCurrent}/${progressTotal} (${pct}%) | Batch ${Math.floor(i / DETAIL_BATCH_SIZE) + 1}`
      );
    }

    // Step 6: Cleanup — slugs that disappeared from OSON
    progressPhase = "cleanup";
    for (const [slug, currentStatus] of dbSlugsMap) {
      if (!osonSlugs.has(slug)) {
        if (currentStatus === "connected") {
          try {
            await osonModel.updateStatus(slug, "deleted");
            stats.markedDeleted++;
          } catch (err) { stats.errors++; }
        } else if (currentStatus === "not_connected") {
          try {
            await osonModel.deletePharmacy(slug);
            stats.deleted++;
          } catch (err) { stats.errors++; }
        }
        // 'deleted' → leave as is
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    lastSyncAt = new Date();
    progressPhase = "done";
    progressCurrent = progressTotal; // 100%

    console.log(`[OSON Sync] ====== Complete in ${duration}s ======`, stats);
    return { success: true, stats, duration, syncedAt: lastSyncAt };

  } catch (err) {
    lastSyncError = err.message;
    progressPhase = "error";
    console.error("[OSON Sync] Fatal error:", err);
    throw err;
  } finally {
    isSyncing = false;
  }
}

// ─── Manual Trigger ────────────────────────────────────────────────────────

async function triggerSync(davoToken) {
  if (davoToken) savedDavoToken = davoToken;
  return runOsonSync(savedDavoToken);
}

// ─── Cron Scheduler ───────────────────────────────────────────────────────

function startOsonCron() {
  cron.schedule(
    "0 12 * * *",
    async () => {
      console.log("[OSON Cron] Daily sync at 12:00 Tashkent");
      if (!savedDavoToken) {
        console.warn("[OSON Cron] No saved token. Skipped.");
        return;
      }
      try {
        await runOsonSync(savedDavoToken);
      } catch (err) {
        console.error("[OSON Cron] Sync failed:", err.message);
      }
    },
    { timezone: "Asia/Tashkent" }
  );
  console.log("[OSON Cron] Scheduled daily at 12:00 Asia/Tashkent");
}

// ─── Status Accessors ──────────────────────────────────────────────────────

function getSyncStatus() {
  return {
    isSyncing,
    lastSyncAt,
    lastSyncError,
    hasToken: !!savedDavoToken,
    progress: {
      current: progressCurrent,
      total: progressTotal,
      percent: progressTotal > 0 ? Math.round((progressCurrent / progressTotal) * 100) : 0,
      phase: progressPhase,
    },
  };
}

module.exports = {
  triggerSync,
  startOsonCron,
  getSyncStatus,
};
