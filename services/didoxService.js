const axios = require("axios");
const db = require("../db");

const BASE = process.env.DIDOX_BASE_URL || "https://api-partners.didox.uz";
const PARTNER_TOKEN = process.env.DIDOX_PARTNER_TOKEN;
const TIN = process.env.DIDOX_TIN;
const PASSWORD = process.env.DIDOX_PASSWORD;

// In-memory fast cache
let memKey = null;
let memExpiresAt = 0;
let memBlockedUntil = 0; // timestamp until which ALL Didox requests are suspended

const KEY_TOKEN = "didox_user_key";
const KEY_EXPIRES = "didox_user_key_expires_at";
const KEY_BLOCKED = "didox_blocked_until";
const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Parse "Слишком много попыток. Попробуйте через 33 минут. 47 секунд"
// Returns wait ms, or null if not parseable
function parseRetryAfterMs(message) {
  if (!message) return null;
  const m = message.match(/через\s+(\d+)\s+минут[а-яё]*\.?\s*(\d+)\s+секунд/i);
  if (m) {
    return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
  }
  // fallback: only minutes
  const m2 = message.match(/через\s+(\d+)\s+минут/i);
  if (m2) return parseInt(m2[1], 10) * 60 * 1000;
  return null;
}

async function readFromDb() {
  try {
    const r = await db.query(
      "SELECT key, value FROM app_settings WHERE key = ANY($1)",
      [[KEY_TOKEN, KEY_EXPIRES, KEY_BLOCKED]]
    );
    const map = Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
    return {
      token: map[KEY_TOKEN] || null,
      expiresAt: parseInt(map[KEY_EXPIRES] || "0", 10),
      blockedUntil: parseInt(map[KEY_BLOCKED] || "0", 10),
    };
  } catch {
    return { token: null, expiresAt: 0, blockedUntil: 0 };
  }
}

async function setSetting(key, value) {
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, String(value)]
    );
  } catch (e) {
    console.warn(`Didox: failed to persist ${key} to DB:`, e.message);
  }
}

// Call this whenever we receive a 429. Stores blockedUntil in memory + DB.
async function handleRateLimit(errorMessage) {
  const waitMs = parseRetryAfterMs(errorMessage);
  // Add 30s buffer so we don't hit the edge
  const blockedUntil = Date.now() + (waitMs || 10 * 60 * 1000) + 30_000;
  memBlockedUntil = blockedUntil;
  await setSetting(KEY_BLOCKED, blockedUntil);
  console.warn(
    `Didox: rate-limited. All requests suspended until ${new Date(blockedUntil).toISOString()}`
  );
}

// Returns true if currently blocked by rate limit
async function isBlocked() {
  const now = Date.now();
  if (memBlockedUntil > now) return true;

  // Check DB in case memBlockedUntil was reset by restart
  const { blockedUntil } = await readFromDb();
  if (blockedUntil > now) {
    memBlockedUntil = blockedUntil; // restore into memory
    return true;
  }
  return false;
}

async function fetchNewUserKey() {
  if (!PARTNER_TOKEN || !PASSWORD) {
    console.warn("Didox: missing DIDOX_PARTNER_TOKEN or DIDOX_PASSWORD");
    return null;
  }
  const res = await axios.post(
    `${BASE}/v1/auth/${TIN}/password/ru`,
    { password: PASSWORD },
    { headers: { "Partner-Authorization": PARTNER_TOKEN, "Content-Type": "application/json" } }
  );
  return res.data?.token || null;
}

async function getUserKey() {
  const now = Date.now();

  // 1. In-memory hit
  if (memKey && now < memExpiresAt) return memKey;

  // 2. DB hit (also loads blockedUntil into memory)
  const { token: dbToken, expiresAt: dbExpires, blockedUntil: dbBlocked } = await readFromDb();
  if (dbBlocked > now) {
    memBlockedUntil = dbBlocked;
    console.warn(`Didox: still rate-limited until ${new Date(dbBlocked).toISOString()}, skipping auth`);
    return null;
  }
  if (dbToken && now < dbExpires) {
    memKey = dbToken;
    memExpiresAt = dbExpires;
    return memKey;
  }

  // 3. Need a fresh token
  try {
    const newToken = await fetchNewUserKey();
    if (!newToken) return null;

    const expiresAt = now + TTL_MS;
    memKey = newToken;
    memExpiresAt = expiresAt;
    await setSetting(KEY_TOKEN, newToken);
    await setSetting(KEY_EXPIRES, expiresAt);
    console.log("Didox: obtained new user-key, valid until", new Date(expiresAt).toISOString());
    return memKey;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    if (status === 429) {
      await handleRateLimit(msg);
    } else {
      console.error("Didox auth failed:", e.response?.data || e.message);
    }
    return null;
  }
}

async function invalidateUserKey() {
  memKey = null;
  memExpiresAt = 0;
  await setSetting(KEY_TOKEN, "");
  await setSetting(KEY_EXPIRES, 0);
}

function buildHeaders(userKey) {
  return {
    "Partner-Authorization": PARTNER_TOKEN,
    "user-key": userKey,
    "Content-Type": "application/json",
  };
}

async function getContractStatusByTin(tin) {
  // Block check before every request
  if (await isBlocked()) return null;

  const userKey = await getUserKey();
  if (!userKey) return null;

  try {
    const res = await axios.get(`${BASE}/v2/documents`, {
      params: { owner: 1, partner: tin, doctype: "000", page: 1, limit: 20 },
      headers: buildHeaders(userKey),
    });
    return pickActual(res.data?.data);
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;

    if (status === 429) {
      await handleRateLimit(msg);
      return null;
    }
    if (status === 401) {
      await invalidateUserKey();
      if (await isBlocked()) return null;
      const uk = await getUserKey();
      if (uk) {
        try {
          const res2 = await axios.get(`${BASE}/v2/documents`, {
            params: { owner: 1, partner: tin, doctype: "000", page: 1, limit: 20 },
            headers: buildHeaders(uk),
          });
          return pickActual(res2.data?.data);
        } catch (e2) {
          const status2 = e2.response?.status;
          const msg2 = e2.response?.data?.error?.message || e2.message;
          if (status2 === 429) await handleRateLimit(msg2);
          else console.error("Didox retry failed:", e2.response?.data || e2.message);
          return null;
        }
      }
    }
    console.error(`Didox getContractStatusByTin(${tin}) failed:`, e.response?.data || e.message);
    return null;
  }
}

function pickActual(data) {
  const list = (data || []).filter((d) => d.doctype === "000" && d.subtype === 3);
  if (!list.length) return null;
  const actual = list.sort((a, b) => (b.created_unix || 0) - (a.created_unix || 0))[0];
  return {
    doc_id: actual.doc_id,
    doc_status: actual.doc_status,
    contract_number: actual.name || actual.contract_number || null,
    partner_company: actual.partnerCompany || null,
    status_comment: actual.status_comment || null,
    created_unix: actual.created_unix || null,
  };
}

async function downloadContractPdf(docId) {
  if (await isBlocked()) return null;

  const userKey = await getUserKey();
  if (!userKey) return null;
  try {
    const res = await axios.get(
      `https://api.didox.uz/v1/documents/${docId}/pdf/shartnoma`,
      { headers: buildHeaders(userKey), responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    if (status === 429) await handleRateLimit(msg);
    else console.error(`Didox downloadContractPdf(${docId}) failed:`, e.message);
    return null;
  }
}

// Exported for testing/debug: how long until block expires (ms), 0 if not blocked
async function getBlockedMs() {
  if (await isBlocked()) return Math.max(0, memBlockedUntil - Date.now());
  return 0;
}

module.exports = { getUserKey, getContractStatusByTin, downloadContractPdf, getBlockedMs };
