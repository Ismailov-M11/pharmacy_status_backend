const cartModel = require("../models/userCartModel");
const syncService = require("../services/userCartSyncService");
const orderSyncService = require("../services/orderStatusSyncService");

// GET /api/user-carts/data
async function getData(req, res) {
  try {
    const { search, status, pharmacies, sources, dateFrom, dateTo, itemsMin, itemsMax, totalMin, totalMax, promoCode, historyStatuses, historyDateFrom, historyDateTo, page = 0, size = 0 } = req.query;

    const filters = {
      search: search || "",
      status: status || "all",
      pharmacies: pharmacies ? (Array.isArray(pharmacies) ? pharmacies : pharmacies.split(",").filter(Boolean)) : [],
      sources: sources ? (Array.isArray(sources) ? sources : sources.split(",").filter(Boolean)) : [],
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      itemsMin: itemsMin || null,
      itemsMax: itemsMax || null,
      totalMin: totalMin || null,
      totalMax: totalMax || null,
      promoCode: promoCode || null,
      historyStatuses: historyStatuses ? (Array.isArray(historyStatuses) ? historyStatuses : historyStatuses.split(",").filter(Boolean)) : [],
      historyDateFrom: historyDateFrom || null,
      historyDateTo: historyDateTo || null,
    };

    const parsedSize = parseInt(size);
    if (parsedSize === 0) {
      // Load all
      const data = await cartModel.getAllCarts(filters);
      return res.json({ data, total: data.length, page: 0, size: data.length });
    }

    const result = await cartModel.getCartsPaginated(filters, parseInt(page), parsedSize);
    res.json({ data: result.data, total: result.total, page: parseInt(page), size: parsedSize });
  } catch (err) {
    console.error("[UserCartController] getData error:", err);
    res.status(500).json({ error: "Failed to load user carts" });
  }
}

// GET /api/user-carts/stats
async function getStats(req, res) {
  try {
    const stats = await cartModel.getSyncStats();
    res.json({
      total: parseInt(stats.total) || 0,
      unprocessed: parseInt(stats.unprocessed) || 0,
      processed: parseInt(stats.processed) || 0,
      lastSyncedAt: stats.last_synced_at || null,
    });
  } catch (err) {
    console.error("[UserCartController] getStats error:", err);
    res.status(500).json({ error: "Failed to load stats" });
  }
}

// GET /api/user-carts/sync-status
async function getSyncStatus(req, res) {
  try {
    const state = syncService.getSyncState();
    const stats = await cartModel.getSyncStats();
    res.json({
      ...state,
      stats: {
        total: parseInt(stats.total) || 0,
        unprocessed: parseInt(stats.unprocessed) || 0,
        processed: parseInt(stats.processed) || 0,
        lastSyncedAt: stats.last_synced_at || null,
      },
    });
  } catch (err) {
    console.error("[UserCartController] getSyncStatus error:", err);
    res.status(500).json({ error: "Failed to get sync status" });
  }
}

// POST /api/user-carts/sync
async function triggerSync(req, res) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      return res.status(401).json({ error: "Authorization token required" });
    }

    const state = syncService.getSyncState();
    if (state.isSyncing) {
      return res.status(409).json({ error: "Sync already in progress" });
    }

    // Fire-and-forget
    syncService.runSync(token).catch((err) => {
      console.error("[UserCartController] Background sync error:", err.message);
    });

    res.json({ success: true, message: "Sync started in background" });
  } catch (err) {
    console.error("[UserCartController] triggerSync error:", err);
    res.status(500).json({ error: "Failed to trigger sync" });
  }
}

// PUT /api/user-carts/:id/comment
async function updateComment(req, res) {
  try {
    const { id } = req.params;
    const { comment, commentBy } = req.body;

    if (!id) return res.status(400).json({ error: "Cart ID required" });

    const updated = await cartModel.updateComment(parseInt(id), comment, commentBy);
    if (!updated) return res.status(404).json({ error: "Cart not found" });

    res.json(updated);
  } catch (err) {
    console.error("[UserCartController] updateComment error:", err);
    res.status(500).json({ error: "Failed to update comment" });
  }
}

// GET /api/user-carts/:id/comments
async function getComments(req, res) {
  try {
    const { id } = req.params;
    const comments = await cartModel.getComments(parseInt(id));
    res.json(comments);
  } catch (err) {
    console.error("[UserCartController] getComments error:", err);
    res.status(500).json({ error: "Failed to load comments" });
  }
}

// POST /api/user-carts/:id/comments
async function addComment(req, res) {
  try {
    const { id } = req.params;
    const { text, createdBy, status } = req.body;
    if (!status) return res.status(400).json({ error: "Status required" });
    const comment = await cartModel.addComment(parseInt(id), text, createdBy, status);
    res.json(comment);
  } catch (err) {
    console.error("[UserCartController] addComment error:", err);
    res.status(500).json({ error: "Failed to add comment" });
  }
}

// GET /api/user-carts/statuses
async function getStatuses(req, res) {
  try {
    const statuses = await cartModel.getStatuses();
    res.json(statuses);
  } catch (err) {
    console.error("[UserCartController] getStatuses error:", err);
    res.status(500).json({ error: "Failed to load statuses" });
  }
}

// POST /api/user-carts/statuses
async function createStatus(req, res) {
  try {
    const { label, createdBy } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: "Label required" });
    const status = await cartModel.createStatus(label, createdBy);
    res.json(status);
  } catch (err) {
    console.error("[UserCartController] createStatus error:", err);
    res.status(500).json({ error: "Failed to create status" });
  }
}

// GET /api/user-carts/filter-options
async function getFilterOptions(req, res) {
  try {
    const [pharmacies, sources, commentUsers] = await Promise.all([
      cartModel.getDistinctPharmacies(),
      cartModel.getDistinctSources(),
      cartModel.getDistinctCommentUsers(),
    ]);
    res.json({ pharmacies, sources, commentUsers });
  } catch (err) {
    console.error("[UserCartController] getFilterOptions error:", err);
    res.status(500).json({ error: "Failed to load filter options" });
  }
}

// GET /api/user-carts/order-sync-status
async function getOrderSyncStatus(req, res) {
  try {
    res.json(orderSyncService.getOrderSyncState());
  } catch (err) {
    console.error("[UserCartController] getOrderSyncStatus error:", err);
    res.status(500).json({ error: "Failed to get order sync status" });
  }
}

// POST /api/user-carts/order-sync
async function triggerOrderSync(req, res) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Authorization token required" });

    const state = orderSyncService.getOrderSyncState();
    if (state.isSyncing) return res.status(409).json({ error: "Order sync already in progress" });

    const result = await orderSyncService.runOrderSync(token);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[UserCartController] triggerOrderSync error:", err);
    res.status(500).json({ error: err.message || "Failed to run order sync" });
  }
}

// POST /api/user-carts/claim
async function claimCustomer(req, res) {
  try {
    const { customerPhone, username } = req.body;
    if (!customerPhone || !username) return res.status(400).json({ error: "customerPhone and username required" });
    const previousClaimer = await cartModel.claimCustomer(customerPhone, username);
    res.json({ success: true, previousClaimer });
  } catch (err) {
    console.error("[UserCartController] claimCustomer error:", err);
    res.status(500).json({ error: "Failed to claim customer" });
  }
}

// DELETE /api/user-carts/claim
async function releaseCustomer(req, res) {
  try {
    const { customerPhone, username } = req.body;
    if (!customerPhone || !username) return res.status(400).json({ error: "customerPhone and username required" });
    await cartModel.releaseCustomer(customerPhone, username);
    res.json({ success: true });
  } catch (err) {
    console.error("[UserCartController] releaseCustomer error:", err);
    res.status(500).json({ error: "Failed to release customer" });
  }
}

module.exports = { getData, getStats, getSyncStatus, triggerSync, updateComment, getComments, addComment, getFilterOptions, getStatuses, createStatus, getOrderSyncStatus, triggerOrderSync, claimCustomer, releaseCustomer };
