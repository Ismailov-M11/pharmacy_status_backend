const axios = require("axios");
const osonModel = require("../models/osonPharmacyModel");
const osonSyncService = require("../services/osonSyncService");

const OSON_API_BASE = "https://dev-api.davodelivery.uz/api/oson";

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

/**
 * GET /api/oson/medicine/filter-options
 * Returns parent regions and regions that have at least one connected pharmacy.
 * Used by medicine search to populate region/city selectors.
 */
async function getMedicineFilterOptions(req, res) {
  try {
    const { parentRegion } = req.query;
    const [parentRegions, regions] = await Promise.all([
      osonModel.getConnectedParentRegions(),
      osonModel.getConnectedRegions(parentRegion || null),
    ]);
    res.json({ parentRegions, regions });
  } catch (error) {
    console.error("[Medicine] getMedicineFilterOptions error:", error);
    res.status(500).json({ error: "Failed to get connected filter options" });
  }
}

/**
 * POST /api/oson/medicine/drug-search
 * Body: { searchText: string }
 * Proxies to OSON Product/Search and returns formatted drug list.
 */
async function searchDrugCatalog(req, res) {
  try {
    const { searchText } = req.body;
    if (!searchText || !searchText.trim()) {
      return res.status(400).json({ error: "searchText is required" });
    }

    const savedToken = osonSyncService.getSavedToken();
    if (!savedToken) {
      return res.status(503).json({
        error: "OSON token not available. Please trigger a sync from OSON Slug List first.",
      });
    }

    const response = await axios.post(
      `${OSON_API_BASE}/Product/Search`,
      {
        searchText: searchText.trim(),
        showOnlyExistOnStore: true,
        onlyApprovedStores: true,
        isOnlineStores: true,
        regionList: [],
        pageSize: 50,
        page: 1,
      },
      {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${savedToken}`,
        },
        timeout: 15000,
      }
    );

    const items = (response.data?.Data?.Items || []).map((item) => ({
      id: item.Slug,
      name: item.ProductName,
      brand: item.BrandName || null,
      manufacturer: item.ManufacturerName || null,
      imageUrl: item.ImageURI || null,
      minPrice: item.MinPrice || 0,
      maxPrice: item.MaxPrice || 0,
      byPrescription: item.IsByPrescription || false,
    }));

    res.json({ items });
  } catch (error) {
    console.error("[Medicine] Drug search error:", error.message);
    if (error.response) {
      return res.status(502).json({ error: "OSON API error: " + (error.response.statusText || "unknown") });
    }
    res.status(500).json({ error: "Drug search failed" });
  }
}

/**
 * POST /api/oson/medicine/stock-search
 * Body: { drugs: [{ id, name, manufacturer, quantity }], parentRegion: string, region?: string }
 * Fetches connected pharmacy slugs for the region, calls OSON stock API, enriches with DB coords.
 */
async function searchStock(req, res) {
  try {
    const { drugs, parentRegion, region } = req.body;

    if (!drugs || !Array.isArray(drugs) || drugs.length === 0) {
      return res.status(400).json({ error: "drugs array is required" });
    }
    if (!parentRegion) {
      return res.status(400).json({ error: "parentRegion is required" });
    }

    const savedToken = osonSyncService.getSavedToken();
    if (!savedToken) {
      return res.status(503).json({
        error: "OSON token not available. Please trigger a sync from OSON Slug List first.",
      });
    }

    // Load connected pharmacy data (slug + coords) for the selected region
    const pharmacyData = await osonModel.getConnectedPharmacyData(
      parentRegion,
      region || null
    );

    if (pharmacyData.length === 0) {
      return res.json({ pharmacies: [], totalPharmacies: 0 });
    }

    const posSlugList = pharmacyData.map((p) => p.slug);
    const pharmacyMap = {};
    pharmacyData.forEach((p) => { pharmacyMap[p.slug] = p; });

    const productList = drugs.map((d) => ({
      slug: d.id,
      quantity: Math.max(1, parseInt(d.quantity) || 1),
    }));

    const response = await axios.post(
      `${OSON_API_BASE}/Pos/ProductList`,
      {
        productList,
        regionList: [],
        posSlugList,
        latitude: null,
        longitude: null,
        maxDistance: 500000,
        isOnline: true,
        sortBy: "price",
        pageSize: 100,
        page: 1,
      },
      {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${savedToken}`,
        },
        timeout: 30000,
      }
    );

    const items = response.data?.Data?.Items || [];

    const pharmacies = items.map((item) => {
      const db = pharmacyMap[item.Slug] || {};
      return {
        id: item.Slug,
        slug: item.Slug,
        name: item.Name,
        address: item.Address || db.address_ru || null,
        landmark: item.Landmark || null,
        regionName: item.RegionName || db.parent_region_ru || null,
        distance: item.Distance || 0,
        totalAmount: item.TotalAmount || 0,
        latitude: db.latitude || null,
        longitude: db.longitude || null,
        phone: db.phone || null,
        openTime: db.open_time || null,
        closeTime: db.close_time || null,
        products: (item.ProductList || []).map((p) => {
          const reqDrug = drugs.find((d) => d.id === p.Slug);
          const qty = reqDrug ? Math.max(1, parseInt(reqDrug.quantity) || 1) : 1;
          return {
            id: p.Slug,
            name: p.ProductName,
            brand: p.BrandName || null,
            manufacturer: p.ManufacturerName || null,
            price: p.Price || 0,
            expiration: p.ExpirationDate || null,
            stock: p.Quantity || 0,
            quantity: qty,
            total: (p.Price || 0) * qty,
          };
        }),
      };
    });

    res.json({ pharmacies, totalPharmacies: pharmacies.length });
  } catch (error) {
    console.error("[Medicine] Stock search error:", error.message);
    if (error.response) {
      return res.status(502).json({ error: "OSON API error: " + (error.response.statusText || "unknown") });
    }
    res.status(500).json({ error: "Stock search failed" });
  }
}

module.exports = {
  getData,
  getStats,
  triggerSync,
  getSyncStatus,
  getFilterOptions,
  getMedicineFilterOptions,
  searchDrugCatalog,
  searchStock,
};
