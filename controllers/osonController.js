const osonModel = require("../models/osonPharmacyModel");
const osonSyncService = require("../services/osonSyncService");

/**
 * GET /api/oson/data
 * Returns paginated OSON pharmacies with optional filters:
 *   ?status=connected|not_connected|deleted|all
 *   ?parentRegion=Ташкент
 *   ?region=Юнусабад
 *   ?search=apteka
 *   ?page=0&size=100   (pagination; size=0 means load all)
 */
async function getData(req, res) {
  try {
    const { status, parentRegion, region, search, page, size } = req.query;

    const pageNum = Math.max(0, parseInt(page) || 0);
    const sizeNum = parseInt(size);
    // size=0 → load all (for map view); default 100
    const loadAll = sizeNum === 0;

    const filters = {
      status: status || "all",
      parentRegion: parentRegion || null,
      region: region || null,
      search: search || null,
    };

    let data, total;
    if (loadAll) {
      const rows = await osonModel.getAllOsonPharmacies(filters);
      data = rows;
      total = rows.length;
    } else {
      const pageSize = Math.min(Math.max(1, sizeNum || 100), 10000);
      ({ data, total } = await osonModel.getOsonPharmaciesPaginated(filters, pageNum, pageSize));
    }

    res.json({
      data,
      total,
      page: loadAll ? 0 : pageNum,
      size: loadAll ? total : (sizeNum || 100),
    });
  } catch (error) {
    console.error("[OSON Controller] getData error:", error);
    res.status(500).json({ error: "Failed to fetch OSON pharmacies" });
  }
}

/**
 * GET /api/oson/stats
 * Returns aggregate counts and last sync time.
 * Accepts the same filter params as /data (parentRegion, region, search)
 * to return filtered counts. Status breakdown is always shown regardless of status filter.
 */
async function getStats(req, res) {
  try {
    const { parentRegion, region, search } = req.query;
    const hasFilter = parentRegion || region || search;

    const stats = hasFilter
      ? await osonModel.getFilteredStats({
          parentRegion: parentRegion || null,
          region: region || null,
          search: search || null,
        })
      : await osonModel.getSyncStats();

    res.json({
      total: parseInt(stats.total) || 0,
      connected: parseInt(stats.connected) || 0,
      not_connected: parseInt(stats.not_connected) || 0,
      deleted: parseInt(stats.deleted) || 0,
      new: parseInt(stats.new) || 0,
      lastSyncedAt: stats.last_synced_at,
    });
  } catch (error) {
    console.error("[OSON Controller] getStats error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
}

/**
 * POST /api/oson/sync
 * Trigger a manual OSON sync.
 * Token should be provided via Authorization header (Bearer <token>)
 */
async function triggerSync(req, res) {
  try {
    // Extract Davo token from Authorization header
    const authHeader = req.headers["authorization"] || req.headers["Authorization"] || "";
    const davoToken = authHeader.replace("Bearer ", "").trim();

    if (!davoToken) {
      return res.status(401).json({
        error: "Authorization token required. Provide Bearer token in Authorization header.",
      });
    }

    // Check if already syncing
    const status = osonSyncService.getSyncStatus();
    if (status.isSyncing) {
      return res.status(409).json({
        error: "Sync already in progress. Please wait.",
        isSyncing: true,
      });
    }

    console.log("[OSON Controller] Manual sync triggered");

    // Run sync in background (don't await — return immediately)
    osonSyncService.triggerSync(davoToken).catch((err) => {
      console.error("[OSON Controller] Background sync error:", err.message);
    });

    res.json({
      success: true,
      message: "Sync started. Use /sync-status to track progress.",
    });
  } catch (error) {
    console.error("[OSON Controller] triggerSync error:", error);
    res.status(500).json({ error: "Failed to start sync" });
  }
}

/**
 * GET /api/oson/sync-status
 * Returns current sync status + stats
 */
async function getSyncStatus(req, res) {
  try {
    const syncStatus = osonSyncService.getSyncStatus();
    const stats = await osonModel.getSyncStats();

    res.json({
      isSyncing: syncStatus.isSyncing,
      lastSyncAt: syncStatus.lastSyncAt,
      lastSyncError: syncStatus.lastSyncError,
      hasToken: syncStatus.hasToken,
      progress: syncStatus.progress,
      stats: {
        total: parseInt(stats.total) || 0,
        connected: parseInt(stats.connected) || 0,
        not_connected: parseInt(stats.not_connected) || 0,
        deleted: parseInt(stats.deleted) || 0,
        new: parseInt(stats.new) || 0,
        lastSyncedAt: stats.last_synced_at,
      },
    });
  } catch (error) {
    console.error("[OSON Controller] getSyncStatus error:", error);
    res.status(500).json({ error: "Failed to get sync status" });
  }
}

/**
 * GET /api/oson/filter-options
 * Returns available filter options (parent regions, regions)
 */
async function getFilterOptions(req, res) {
  try {
    const { parentRegion } = req.query;

    const [parentRegions, regions] = await Promise.all([
      osonModel.getDistinctParentRegions(),
      osonModel.getDistinctRegions(parentRegion || null),
    ]);

    res.json({ parentRegions, regions });
  } catch (error) {
    console.error("[OSON Controller] getFilterOptions error:", error);
    res.status(500).json({ error: "Failed to get filter options" });
  }
}

module.exports = {
  getData,
  getStats,
  triggerSync,
  getSyncStatus,
  getFilterOptions,
};
