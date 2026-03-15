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

// ─── State ─────────────────────────────────────────────────────────────────
let isSyncing = false;
let lastSyncAt = null;
let lastSyncError = null;
let savedDavoToken = null; // Сохраняем токен для cron

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch all slugs from OSON for all regions
 * Returns a Set of slug strings
 */
async function fetchAllOsonSlugs() {
  const allSlugs = new Set();
  const errors = [];

  for (const region of OSON_REGIONS) {
    try {
      const response = await axios.get(`${OSON_API_BASE}/SlugList`, {
        params: { region },
        headers: OSON_HEADERS,
        timeout: 15000,
      });

      if (response.data?.Succeeded && response.data?.Data?.Items) {
        const slugs = response.data.Data.Items;
        slugs.forEach((slug) => allSlugs.add(slug));
        console.log(
          `[OSON Sync] Region "${region}": ${slugs.length} pharmacies`
        );
      }
    } catch (err) {
      console.error(
        `[OSON Sync] Failed to fetch region "${region}":`,
        err.message
      );
      errors.push(region);
    }

    // Small delay to avoid overwhelming OSON API
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(
    `[OSON Sync] Total unique slugs from OSON: ${allSlugs.size} (${errors.length} regions failed)`
  );
  return allSlugs;
}

/**
 * Fetch pharmacy details from OSON TileInfo API
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
  } catch (err) {
    console.error(`[OSON Sync] Failed to fetch TileInfo for "${slug}":`, err.message);
    return null;
  }
}

/**
 * Fetch all connected pharmacy slugs from Davo API
 * Returns a Set of slug strings
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
        timeout: 15000,
      }
    );

    const list = response.data?.payload?.list || [];
    const slugSet = new Set();
    list.forEach((market) => {
      if (market.slug) slugSet.add(market.slug);
    });

    console.log(`[OSON Sync] Connected pharmacies in Davo: ${slugSet.size}`);
    return slugSet;
  } catch (err) {
    console.error("[OSON Sync] Failed to fetch Davo market list:", err.message);
    return new Set();
  }
}

// ─── Main Sync Function ────────────────────────────────────────────────────

/**
 * Main synchronization function
 * @param {string} davoToken - Bearer token for davodelivery API
 */
async function runOsonSync(davoToken) {
  if (isSyncing) {
    console.log("[OSON Sync] Already running, skipping.");
    return { skipped: true };
  }

  isSyncing = true;
  lastSyncError = null;
  const startTime = Date.now();

  console.log("[OSON Sync] ====== Starting OSON Sync ======");

  try {
    // Step 1: Get all OSON slugs
    const osonSlugs = await fetchAllOsonSlugs();

    // Step 2: Get connected slugs from Davo
    const davoSlugs = await fetchDavoConnectedSlugs(davoToken);

    // Step 3: Get existing DB slugs + statuses
    const dbSlugsMap = await osonModel.getAllSlugsWithStatus();

    // Step 4: Counters
    let stats = {
      inserted: 0,
      updated: 0,
      statusChanged: 0,
      deleted: 0,
      markedDeleted: 0,
    };

    // Step 5: Process each OSON slug (that exists in OSON right now)
    for (const slug of osonSlugs) {
      const isConnectedInDavo = davoSlugs.has(slug);
      const currentDbStatus = dbSlugsMap.get(slug); // undefined if not in DB

      // Determine new status
      let newStatus;
      if (isConnectedInDavo) {
        newStatus = "connected";
      } else {
        // If it was 'deleted' before and now it's back in OSON but not in Davo
        // → restore to 'not_connected'
        if (currentDbStatus === "deleted") {
          newStatus = "not_connected";
        } else {
          newStatus = "not_connected";
        }
      }

      if (currentDbStatus === undefined) {
        // Brand new slug — fetch details and insert
        const detail = await fetchOsonPharmacyDetail(slug);

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
          } catch (upsertErr) {
            console.error(`[OSON Sync] Failed to upsert slug "${slug}":`, upsertErr.message);
            stats.errors = (stats.errors || 0) + 1;
          }
        }

        // Small delay between detail requests
        await new Promise((r) => setTimeout(r, 100));
      } else {
        // Existing slug — just update status if changed
        try {
          if (currentDbStatus !== newStatus) {
            await osonModel.updateStatus(slug, newStatus);
            stats.statusChanged++;
          } else {
            // Update last_synced_at only
            await osonModel.updateStatus(slug, currentDbStatus);
            stats.updated++;
          }
        } catch (updateErr) {
          console.error(`[OSON Sync] Failed to update slug "${slug}":`, updateErr.message);
          stats.errors = (stats.errors || 0) + 1;
        }
      }
    }

    // Step 6: Handle slugs that were in DB but NOT in OSON anymore
    for (const [slug, currentStatus] of dbSlugsMap) {
      if (!osonSlugs.has(slug)) {
        if (currentStatus === "connected") {
          // Was connected → mark as deleted
          await osonModel.updateStatus(slug, "deleted");
          stats.markedDeleted++;
          console.log(`[OSON Sync] Marked as deleted (was connected): ${slug}`);
        } else if (currentStatus === "not_connected") {
          // Was not connected + disappeared → delete from DB entirely
          await osonModel.deletePharmacy(slug);
          stats.deleted++;
          console.log(`[OSON Sync] Physically deleted (was not_connected): ${slug}`);
        }
        // If already 'deleted' → leave as is
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    lastSyncAt = new Date();

    console.log(`[OSON Sync] ====== Sync Complete in ${duration}s ======`);
    console.log(`[OSON Sync] Stats:`, stats);

    return { success: true, stats, duration, syncedAt: lastSyncAt };
  } catch (err) {
    lastSyncError = err.message;
    console.error("[OSON Sync] Fatal error:", err);
    throw err;
  } finally {
    isSyncing = false;
  }
}

// ─── Manual Trigger ────────────────────────────────────────────────────────

/**
 * Trigger sync manually (e.g. from API endpoint)
 * Saves the token for future cron runs
 */
async function triggerSync(davoToken) {
  if (davoToken) {
    savedDavoToken = davoToken; // Save for cron reuse
  }
  return runOsonSync(savedDavoToken);
}

// ─── Cron Scheduler ───────────────────────────────────────────────────────

function startOsonCron() {
  // Every day at 12:00 Tashkent time (UTC+5 = 07:00 UTC)
  cron.schedule(
    "0 12 * * *",
    async () => {
      console.log("[OSON Cron] Triggered daily sync at 12:00 (Tashkent)");

      if (!savedDavoToken) {
        console.warn(
          "[OSON Cron] No saved Davo token. Sync skipped. A user must trigger a manual sync first."
        );
        return;
      }

      try {
        await runOsonSync(savedDavoToken);
      } catch (err) {
        console.error("[OSON Cron] Sync failed:", err.message);
      }
    },
    {
      timezone: "Asia/Tashkent",
    }
  );

  console.log("[OSON Cron] Scheduled daily sync at 12:00 Asia/Tashkent");
}

// ─── Status Accessors ──────────────────────────────────────────────────────

function getSyncStatus() {
  return {
    isSyncing,
    lastSyncAt,
    lastSyncError,
    hasToken: !!savedDavoToken,
  };
}

module.exports = {
  triggerSync,
  startOsonCron,
  getSyncStatus,
};
