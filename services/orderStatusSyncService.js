const cron = require("node-cron");
const axios = require("axios");
const cartModel = require("../models/userCartModel");

const ORDER_LIST_URL = "https://api.davodelivery.uz/api/order/list";

let isSyncing = false;
let lastSyncAt = null;
let lastSyncError = null;
let lastSyncResult = { delivered: 0, cancelled: 0, inProgress: 0, checked: 0 };
let savedDavoToken = null;

async function fetchOrdersByPhone(token, phone) {
  const size = 100;
  const body = { searchKey: phone, page: 0, size };
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const first = await axios.post(ORDER_LIST_URL, body, { headers, timeout: 30000 });
  const payload = first.data?.payload;
  if (!payload) throw new Error(`Unexpected API response for phone ${phone}`);

  const total = payload.total || 0;
  const all = [...(payload.list || [])];
  const totalPages = Math.ceil(total / size);

  for (let page = 1; page < totalPages; page++) {
    const res = await axios.post(ORDER_LIST_URL, { ...body, page }, { headers, timeout: 30000 });
    all.push(...(res.data?.payload?.list || []));
  }

  return all;
}

async function runOrderSync(token) {
  if (isSyncing) throw new Error("Order status sync already in progress");

  const useToken = token || savedDavoToken;
  if (!useToken) throw new Error("No Davo token available. Trigger a manual sync first.");
  if (token) savedDavoToken = token;

  isSyncing = true;
  lastSyncError = null;

  try {
    // Carts with invoice_id that haven't reached a terminal status yet
    const activeCarts = await cartModel.getCartsForOrderSync();

    if (!activeCarts.length) {
      lastSyncAt = new Date().toISOString();
      lastSyncResult = { delivered: 0, cancelled: 0, inProgress: 0, checked: 0 };
      return lastSyncResult;
    }

    // Group by customer_phone; each phone → { invoice_id → cart_id }
    const phoneMap = new Map(); // phone → Map<invoice_id, cart_id>
    for (const cart of activeCarts) {
      if (!cart.customer_phone || !cart.invoice_id) continue;
      if (!phoneMap.has(cart.customer_phone)) phoneMap.set(cart.customer_phone, new Map());
      phoneMap.get(cart.customer_phone).set(cart.invoice_id, cart.id);
    }

    const updates = [];

    for (const [phone, invoiceToCartId] of phoneMap) {
      let orders;
      try {
        orders = await fetchOrdersByPhone(useToken, phone);
      } catch (err) {
        console.warn(`[OrderStatusSync] Failed to fetch orders for phone ${phone}:`, err.message);
        continue;
      }

      // Build a map of invoice_id → order status from API response
      const apiInvoiceStatus = new Map(); // invoice_id → 'COMPLETED' | 'CANCELLED' | 'ACTIVE'
      for (const order of orders) {
        const invoiceId = order.invoice?.id;
        if (!invoiceId) continue;
        apiInvoiceStatus.set(invoiceId, order.status);
      }

      // For each cart belonging to this phone, determine new order_status
      for (const [invoiceId, cartId] of invoiceToCartId) {
        const apiStatus = apiInvoiceStatus.get(invoiceId);

        if (apiStatus === undefined) {
          // invoice_id not found in this customer's orders → leave as pending (no update)
          continue;
        }

        let newOrderStatus;
        if (apiStatus === "COMPLETED") {
          newOrderStatus = "delivered";
        } else if (apiStatus === "CANCELLED") {
          newOrderStatus = "cancelled";
        } else {
          // NEW, CONFIRMED, READY, WAITING_FOR_COURIER, PICKED_UP, etc. → Доставляется
          newOrderStatus = "in_progress";
        }

        updates.push({ id: cartId, orderStatus: newOrderStatus, orderCode: order.code ?? null });
      }
    }

    if (updates.length) {
      await cartModel.bulkUpdateOrderStatus(updates);
    }

    lastSyncAt = new Date().toISOString();
    lastSyncResult = {
      delivered:  updates.filter((u) => u.orderStatus === "delivered").length,
      cancelled:  updates.filter((u) => u.orderStatus === "cancelled").length,
      inProgress: updates.filter((u) => u.orderStatus === "in_progress").length,
      checked:    activeCarts.length,
    };

    console.log(
      `[OrderStatusSync] Done. Checked: ${activeCarts.length}, ` +
      `Delivered: ${lastSyncResult.delivered}, Cancelled: ${lastSyncResult.cancelled}, ` +
      `In progress: ${lastSyncResult.inProgress}`
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
