const axios = require("axios");
const db = require("../db");

const BASE = process.env.DIDOX_BASE_URL || "https://api-partners.didox.uz";
const PARTNER_TOKEN = process.env.DIDOX_PARTNER_TOKEN;
const TIN = process.env.DIDOX_TIN;
const PASSWORD = process.env.DIDOX_PASSWORD;

// In-memory fast cache
let memKey = null;
let memExpiresAt = 0;
let memBlockedUntil = 0;

const KEY_TOKEN = "didox_user_key";
const KEY_EXPIRES = "didox_user_key_expires_at";
const KEY_BLOCKED = "didox_blocked_until";
const TTL_MS = 4 * 60 * 60 * 1000;

function log(...args)  { console.log ("[Didox]", ...args); }
function warn(...args) { console.warn("[Didox]", ...args); }
function err(...args)  { console.error("[Didox]", ...args); }

function parseRetryAfterMs(message) {
  if (!message) return null;
  const m = message.match(/через\s+(\d+)\s+минут[а-яё]*\.?\s*(\d+)\s+секунд/i);
  if (m) return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
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
    warn(`failed to persist ${key} to DB:`, e.message);
  }
}

async function handleRateLimit(errorMessage) {
  const waitMs = parseRetryAfterMs(errorMessage);
  const blockedUntil = Date.now() + (waitMs || 10 * 60 * 1000) + 30_000;
  memBlockedUntil = blockedUntil;
  await setSetting(KEY_BLOCKED, blockedUntil);
  warn(`rate-limited. Suspended until ${new Date(blockedUntil).toISOString()}`);
}

async function isBlocked() {
  const now = Date.now();
  if (memBlockedUntil > now) return true;
  const { blockedUntil } = await readFromDb();
  if (blockedUntil > now) {
    memBlockedUntil = blockedUntil;
    return true;
  }
  return false;
}

async function fetchNewUserKey() {
  // ── ENV check ────────────────────────────────────────────────────────────
  log(`ENV check → TIN=${TIN ? TIN : "MISSING"} | PASSWORD=${PASSWORD ? "SET" : "MISSING"} | PARTNER_TOKEN=${PARTNER_TOKEN ? "SET" : "MISSING"}`);

  if (!TIN || !PASSWORD) {
    warn("DIDOX_TIN or DIDOX_PASSWORD not set in environment — cannot authenticate");
    return null;
  }

  const url = `${BASE}/v1/auth/${TIN}/password/ru`;
  log(`POST ${url}`);

  const res = await axios.post(
    url,
    { password: PASSWORD },
    { headers: { "Content-Type": "application/json" } }
  );

  const token = res.data?.token || null;
  log(`Auth response → token=${token ? token.slice(0, 8) + "..." : "NULL"}`);
  return token;
}

async function getUserKey() {
  const now = Date.now();

  if (memKey && now < memExpiresAt) {
    log(`getUserKey → in-memory hit (expires ${new Date(memExpiresAt).toISOString()})`);
    return memKey;
  }

  const { token: dbToken, expiresAt: dbExpires, blockedUntil: dbBlocked } = await readFromDb();

  if (dbBlocked > now) {
    memBlockedUntil = dbBlocked;
    warn(`rate-limited until ${new Date(dbBlocked).toISOString()}, skipping auth`);
    return null;
  }

  if (dbToken && now < dbExpires) {
    log(`getUserKey → DB hit (expires ${new Date(dbExpires).toISOString()})`);
    memKey = dbToken;
    memExpiresAt = dbExpires;
    return memKey;
  }

  log("getUserKey → no valid token in memory or DB, fetching new one...");
  try {
    const newToken = await fetchNewUserKey();
    if (!newToken) return null;

    const expiresAt = now + TTL_MS;
    memKey = newToken;
    memExpiresAt = expiresAt;
    await setSetting(KEY_TOKEN, newToken);
    await setSetting(KEY_EXPIRES, expiresAt);
    log(`new user-key obtained, valid until ${new Date(expiresAt).toISOString()}`);
    return memKey;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    if (status === 429) {
      await handleRateLimit(msg);
    } else {
      err("auth failed:", status, msg);
    }
    return null;
  }
}

async function invalidateUserKey() {
  log("invalidating user-key (401 received)");
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
  tin = String(tin).replace(/\s+/g, ""); // убираем все пробелы (начало, конец, середина)
  log(`getContractStatusByTin(${tin}) → start`);

  if (await isBlocked()) {
    warn(`getContractStatusByTin(${tin}) → blocked by rate-limit, skipping`);
    return null;
  }

  const userKey = await getUserKey();
  if (!userKey) {
    warn(`getContractStatusByTin(${tin}) → no user-key, returning null`);
    return null;
  }

  const url = `${BASE}/v2/documents`;
  const params = { owner: 1, partner: tin, doctype: "000", page: 1, limit: 20 };
  log(`GET ${url} params=${JSON.stringify(params)}`);

  try {
    const res = await axios.get(url, { params, headers: buildHeaders(userKey) });
    const rawData = res.data?.data || [];
    log(`getContractStatusByTin(${tin}) → Didox returned ${rawData.length} docs`);
    rawData.forEach((d, i) =>
      log(`  doc[${i}] doc_id=${d.doc_id} doc_status=${d.doc_status} doctype=${d.doctype} subtype=${d.subtype}`)
    );

    const result = pickActual(rawData);
    log(`getContractStatusByTin(${tin}) → picked: ${result ? `doc_status=${result.doc_status}` : "null (no matching docs)"}`);
    return result;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;

    err(`getContractStatusByTin(${tin}) → HTTP ${status}: ${msg}`);

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
          log(`getContractStatusByTin(${tin}) → retry after 401`);
          const res2 = await axios.get(url, { params, headers: buildHeaders(uk) });
          return pickActual(res2.data?.data);
        } catch (e2) {
          const s2 = e2.response?.status;
          const m2 = e2.response?.data?.error?.message || e2.message;
          if (s2 === 429) await handleRateLimit(m2);
          else err(`retry failed: HTTP ${s2}: ${m2}`);
          return null;
        }
      }
    }
    return null;
  }
}

function pickActual(data) {
  const list = (data || []).filter((d) => d.doctype === "000" && [1, 3, 4].includes(d.doc_status));
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
    else err(`downloadContractPdf(${docId}) failed: HTTP ${status}: ${msg}`);
    return null;
  }
}

async function getBlockedMs() {
  if (await isBlocked()) return Math.max(0, memBlockedUntil - Date.now());
  return 0;
}

module.exports = { getUserKey, getContractStatusByTin, downloadContractPdf, getBlockedMs };
