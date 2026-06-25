const axios = require("axios");
const cron = require("node-cron");
const osonModel = require("../models/osonPharmacyModel");

// ─── OSON API Config ───────────────────────────────────────────────────────
const OSON_API_BASE = "https://dev-api.davodelivery.uz/api/oson";

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
const DETAIL_BATCH_SIZE = 50;

// ─── State ─────────────────────────────────────────────────────────────────
let isSyncing = false;
let lastSyncAt = null;
let lastSyncError = null;
let savedDavoToken = null;

let progressCurrent = 0;
let progressTotal = 0;
let progressPhase = "";

// ─── Helpers ───────────────────────────────────────────────────────────────

async function fetchAllOsonSlugs(davoToken) {
  const allSlugs = new Set();

  const results = await Promise.allSettled(
    OSON_REGIONS.map((region) =>
      axios
        .get(`${OSON_API_BASE}/POS/SlugList`, {
          params: { region },
          headers: {
            accept: "application/json",
            Authorization: `Bearer ${davoToken}`,
          },
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

async function fetchOsonPharmacyDetail(slug, davoToken) {
  try {
    const response = await axios.get(`${OSON_API_BASE}/POS/TileInfo/${slug}`, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${davoToken}`,
      },
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

async function fetchDetailBatch(slugs, davoToken) {
  const results = await Promise.allSettled(
    slugs.map((slug) => fetchOsonPharmacyDetail(slug, davoToken).then((d) => ({ slug, d })))
  );

  const map = new Map();
  results.forEach((r) => {
    if (r.status === "fulfilled" && r.value.d) {
      map.set(r.value.slug, r.value.d);
    }
  });
  return map;
}

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
    console.error("[OSON Sync] Failed to fetch Davo market list:", err.message);
    return new Set();
  }
}

async function fetchLeadSlugs(davoToken) {
  try {
    const response = await axios.post(
      `${DAVO_API_BASE}/lead/list`,
      { searchKey: "", page: 0, size: 50000 },
      {
        headers: {
          authorization: `Bearer ${davoToken}`,
          "content-type": "application/json",
        },
        timeout: 30000,
      }
    );

    const list = response.data?.payload?.list || [];
    const slugSet = new Set();
    list.forEach((m) => { if (m.slug) slugSet.add(m.slug); });

    console.log(`[OSON Sync] Leads in Davo: ${slugSet.size}`);
    return slugSet;
  } catch (err) {
    console.error("[OSON Sync] Failed to fetch Davo lead list:", err.message);
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
    progressPhase = "collecting";
    const [osonSlugs, davoSlugs, leadSlugs] = await Promise.all([
      fetchAllOsonSlugs(davoToken),
      fetchDavoConnectedSlugs(davoToken),
      fetchLeadSlugs(davoToken),
    ]);
    const dbSlugsMap = await osonModel.getAllSlugsWithStatus();

    const stats = { inserted: 0, updated: 0, statusChanged: 0, deleted: 0, markedDeleted: 0, errors: 0 };

    const newSlugs = [];
    const existingSlugs = [];

    for (const slug of osonSlugs) {
      if (dbSlugsMap.has(slug)) {
        existingSlugs.push(slug);
      } else {
        newSlugs.push(slug);
      }
    }

    progressTotal = newSlugs.length + existingSlugs.length;
    progressPhase = "syncing";

    console.log(`[OSON Sync] New slugs: ${newSlugs.length}, Existing: ${existingSlugs.length}`);

    // ── Step 5a: Process EXISTING slugs ──
    // Fetch TileInfo for each batch to get SyncedTime from OSON API.
    for (let i = 0; i < existingSlugs.length; i += DETAIL_BATCH_SIZE) {
      const batch = existingSlugs.slice(i, i + DETAIL_BATCH_SIZE);
      const detailMap = await fetchDetailBatch(batch, davoToken);

      await Promise.allSettled(
        batch.map(async (slug) => {
          const currentDbStatus = dbSlugsMap.get(slug);
          const newStatus = davoSlugs.has(slug) ? "connected"
            : leadSlugs.has(slug) ? "not_connected"
            : "new";
          const detail = detailMap.get(slug);

          try {
            if (detail) {
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
                  oson_synced_time: detail.SyncedTime || null,
                },
                newStatus
              );
            } else {
              await osonModel.updateStatusAndSyncedTime(slug, newStatus, null);
            }
            if (currentDbStatus !== newStatus) {
              stats.statusChanged++;
            } else {
              stats.updated++;
            }
          } catch (err) {
            console.error(`[OSON Sync] Update error "${slug}":`, err.message);
            stats.errors++;
          }
          progressCurrent++;
        })
      );

      const pct = Math.round((progressCurrent / progressTotal) * 100);
      console.log(
        `[OSON Sync] Existing batch ${Math.floor(i / DETAIL_BATCH_SIZE) + 1}: ${progressCurrent}/${progressTotal} (${pct}%)`
      );
    }

    // ── Step 5b: Process NEW slugs (full upsert with TileInfo) ──
    for (let i = 0; i < newSlugs.length; i += DETAIL_BATCH_SIZE) {
      const batch = newSlugs.slice(i, i + DETAIL_BATCH_SIZE);
      const detailMap = await fetchDetailBatch(batch, davoToken);

      await Promise.allSettled(
        batch.map(async (slug) => {
          const detail = detailMap.get(slug);
          const newStatus = davoSlugs.has(slug) ? "connected"
            : leadSlugs.has(slug) ? "not_connected"
            : "new";

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
                  oson_synced_time: detail.SyncedTime || null,
                },
                newStatus
              );
              stats.inserted++;
            } catch (err) {
              console.error(`[OSON Sync] Upsert error "${slug}":`, err.message);
              stats.errors++;
            }
          } else {
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
        `[OSON Sync] New batch ${Math.floor(i / DETAIL_BATCH_SIZE) + 1}: ${progressCurrent}/${progressTotal} (${pct}%)`
      );
    }

    // Step 6: Cleanup
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
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    lastSyncAt = new Date();
    progressPhase = "done";
    progressCurrent = progressTotal;

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

async function triggerSync(davoToken) {
  if (davoToken) savedDavoToken = davoToken;
  return runOsonSync(savedDavoToken);
}

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

function getSavedToken() {
  return savedDavoToken;
}

module.exports = {
  triggerSync,
  startOsonCron,
  getSyncStatus,
  getSavedToken,
};
