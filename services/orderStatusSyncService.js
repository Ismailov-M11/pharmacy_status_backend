const cron = require("node-cron");
const axios = require("axios");
const cartModel = require("../models/userCartModel");

const ORDER_LIST_URL = "https://api.davodelivery.uz/api/order/list";

let isSyncing = false;
let lastSyncAt = null;
let lastSyncError = null;
let lastSyncResult = { delivered: 0, cancelled: 0, checked: 0 };
let savedDavoToken = null;

async function fetchOrderPage(token, status, page, size) {
  const response = await axios.post(
    ORDER_LIST_URL,
    { status, page, size },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  const payload = response.data?.payload;
  if (!payload) throw new Error("Unexpected API response from order/list");
  return payload; // { list, total }
}

async function fetchAllOrdersByStatus(token, status) {
  const size = 100;
  const first = await fetchOrderPage(token, status, 0, size);
  const total = first.total || 0;
  const all = [...(first.list || [])];
  const totalPages = Math.ceil(total / size);
  for (let page = 1; page < totalPages; page++) {
    const data = await fetchOrderPage(token, status, page, size);
    all.push(...(data.list || []));
  }
  return all;
}

function extractInvoiceId(order) {
  // Handle different possible API response shapes
  return order.invoice?.id ?? order.invoiceId ?? order.invoice_id ?? null;
}

async function runOrderSync(token) {
  if (isSyncing) throw new Error("Order status sync already in progress");

  const useToken = token || savedDavoToken;
  if (!useToken) throw new Error("No Davo token available. Trigger a manual sync first.");
  if (token) savedDavoToken = token;

  isSyncing = true;
  lastSyncError = null;

  try {
    const activeCarts = await cartModel.getCartsForOrderSync();

    if (!activeCarts.length) {
      lastSyncAt = new Date().toISOString();
      lastSyncResult = { delivered: 0, cancelled: 0, checked: 0 };
      return lastSyncResult;
    }

    // Build invoice_id → [cart_ids] map
    const invoiceMap = new Map();

    for (const cart of activeCarts) {
      if (!cart.invoice_id) continue;
      if (!invoiceMap.has(cart.invoice_id)) invoiceMap.set(cart.invoice_id, []);
      invoiceMap.get(cart.invoice_id).push(cart.id);
    }

    if (!invoiceMap.size) {
      lastSyncAt = new Date().toISOString();
      lastSyncResult = { delivered: 0, cancelled: 0, checked: activeCarts.length };
      return lastSyncResult;
    }

    const updates = [];

    // Fetch COMPLETED orders → mark as delivered
    const completed = await fetchAllOrdersByStatus(useToken, "COMPLETED");
    for (const order of completed) {
      const invoiceId = extractInvoiceId(order);
      if (invoiceId && invoiceMap.has(invoiceId)) {
        for (const cartId of invoiceMap.get(invoiceId)) {
          updates.push({ id: cartId, orderStatus: "delivered" });
        }
        invoiceMap.delete(invoiceId);
      }
    }

    // Fetch CANCELLED orders → mark as cancelled
    const cancelled = await fetchAllOrdersByStatus(useToken, "CANCELLED");
    for (const order of cancelled) {
      const invoiceId = extractInvoiceId(order);
      if (invoiceId && invoiceMap.has(invoiceId)) {
        for (const cartId of invoiceMap.get(invoiceId)) {
          updates.push({ id: cartId, orderStatus: "cancelled" });
        }
        invoiceMap.delete(invoiceId);
      }
    }

    if (updates.length) {
      await cartModel.bulkUpdateOrderStatus(updates);
    }

    lastSyncAt = new Date().toISOString();
    lastSyncResult = {
      delivered: updates.filter((u) => u.orderStatus === "delivered").length,
      cancelled: updates.filter((u) => u.orderStatus === "cancelled").length,
      checked: activeCarts.length,
    };

    console.log(
      `[OrderStatusSync] Done. Checked: ${activeCarts.length}, ` +
      `Delivered: ${lastSyncResult.delivered}, Cancelled: ${lastSyncResult.cancelled}`
    );
    return lastSyncResult;
  } catch (err) {
    lastSyncError = err.message;
    console.error("[OrderStatusSync] Sync failed:", err.message);
    throw err;
  } finally {
    isSyncing = false;
  }
}

function startOrderStatusCron() {
  cron.schedule(
    "0 12 * * *",
    async () => {
      console.log("[OrderStatusSync] Starting scheduled sync...");
      try {
        await runOrderSync(null);
      } catch (err) {
        console.error("[OrderStatusSync] Scheduled sync error:", err.message);
      }
    },
    { timezone: "Asia/Tashkent" }
  );
  console.log("[OrderStatusSync] Cron scheduled: daily at 12:00 Tashkent time.");
}

function getOrderSyncState() {
  return { isSyncing, lastSyncAt, lastSyncError, lastSyncResult, hasToken: !!savedDavoToken };
}

module.exports = { startOrderStatusCron, runOrderSync, getOrderSyncState };
