const cron = require("node-cron");
const axios = require("axios");
const cartModel = require("../models/userCartModel");

const DRAFT_LIST_URL = "https://api.davodelivery.uz/api/order/draft/list";
const PAGE_SIZE = 100;

// ─── In-memory state ──────────────────────────────────────────────────────────
let isSyncing = false;
let lastSyncAt = null;
let lastSyncError = null;
let savedDavoToken = null;
let progress = { current: 0, total: 0, percent: 0, phase: "" };

function setProgress(current, total, phase) {
  progress = {
    current,
    total,
    percent: total > 0 ? Math.round((current / total) * 100) : 0,
    phase,
  };
}

// ─── Core sync ────────────────────────────────────────────────────────────────
async function fetchPage(token, page, size) {
  const response = await axios.post(
    DRAFT_LIST_URL,
    { page, size, withoutUpdates: true },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  const payload = response.data?.payload;
  if (!payload) throw new Error("Unexpected API response structure");
  return payload; // { list, total }
}

async function runSync(token) {
  if (isSyncing) {
    throw new Error("Sync already in progress");
  }

  const useToken = token || savedDavoToken;
  if (!useToken) {
    throw new Error("No Davo token available. Trigger a manual sync first.");
  }

  if (token) savedDavoToken = token;

  isSyncing = true;
  lastSyncError = null;
  setProgress(0, 0, "collecting");

  const syncStartAt = new Date(); // timestamp before first API call

  try {
    // First page to get total count
    const firstPage = await fetchPage(useToken, 0, PAGE_SIZE);
    const total = firstPage.total || 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);

    setProgress(firstPage.list.length, total, "syncing");

    const allItems = [...firstPage.list];

    // Fetch remaining pages
    for (let page = 1; page < totalPages; page++) {
      const pageData = await fetchPage(useToken, page, PAGE_SIZE);
      allItems.push(...pageData.list);
      setProgress(allItems.length, total, "syncing");
    }

    // Upsert all items
    setProgress(0, allItems.length, "saving");
    for (let i = 0; i < allItems.length; i++) {
      await cartModel.upsertCart(allItems[i]);
      if ((i + 1) % 50 === 0 || i === allItems.length - 1) {
        setProgress(i + 1, allItems.length, "saving");
      }
    }

    // Mark carts that disappeared from draft/list as deleted
    // (last_synced_at < syncStartAt means they were not touched in this sync)
    const deletedCount = await cartModel.markMissingCartsDeleted(syncStartAt);
    if (deletedCount > 0) {
      console.log(`[UserCartSync] Marked ${deletedCount} absent carts as deleted.`);
    }

    lastSyncAt = new Date().toISOString();
    setProgress(allItems.length, allItems.length, "done");
    console.log(`[UserCartSync] Synced ${allItems.length} carts successfully.`);
  } catch (err) {
    lastSyncError = err.message;
    setProgress(0, 0, "error");
    console.error("[UserCartSync] Sync failed:", err.message);
    throw err;
  } finally {
    isSyncing = false;
  }
}

// ─── Cron: daily at 12:00 Tashkent time ──────────────────────────────────────
function startUserCartCron() {
  cron.schedule(
    "*/30 * * * *",
    async () => {
      console.log("[UserCartSync] Starting scheduled sync...");
      try {
        await runSync(null);
      } catch (err) {
        console.error("[UserCartSync] Scheduled sync error:", err.message);
      }
    },
    { timezone: "Asia/Tashkent" }
  );
  console.log("[UserCartSync] Cron scheduled: every 30 minutes (Tashkent time).");
}

function getSyncState() {
  return { isSyncing, lastSyncAt, lastSyncError, hasToken: !!savedDavoToken, progress };
}

module.exports = { startUserCartCron, runSync, getSyncState };
