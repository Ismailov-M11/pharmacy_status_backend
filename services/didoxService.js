const axios = require("axios");
const db = require("../db");

const BASE = process.env.DIDOX_BASE_URL || "https://api-partners.didox.uz";
const PARTNER_TOKEN = process.env.DIDOX_PARTNER_TOKEN;
const TIN = process.env.DIDOX_TIN;
const PASSWORD = process.env.DIDOX_PASSWORD;

// In-memory fast cache — populated from DB on first use
let memKey = null;
let memExpiresAt = 0;

const KEY_TOKEN = "didox_user_key";
const KEY_EXPIRES = "didox_user_key_expires_at";
// Lifetime: 4 hours (Didox sessions last several hours; we renew well before expiry)
const TTL_MS = 4 * 60 * 60 * 1000;

async function readFromDb() {
  try {
    const r = await db.query(
      "SELECT key, value FROM app_settings WHERE key = ANY($1)",
      [[KEY_TOKEN, KEY_EXPIRES]]
    );
    const map = Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
    const token = map[KEY_TOKEN] || null;
    const expiresAt = parseInt(map[KEY_EXPIRES] || "0", 10);
    return { token, expiresAt };
  } catch {
    return { token: null, expiresAt: 0 };
  }
}

async function writeToDb(token, expiresAt) {
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [KEY_TOKEN, token]
    );
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [KEY_EXPIRES, String(expiresAt)]
    );
  } catch (e) {
    console.warn("Didox: failed to persist user-key to DB:", e.message);
  }
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

  // 2. DB hit
  const { token: dbToken, expiresAt: dbExpires } = await readFromDb();
  if (dbToken && now < dbExpires) {
    memKey = dbToken;
    memExpiresAt = dbExpires;
    return memKey;
  }

  // 3. Need a fresh token — call Didox
  try {
    const newToken = await fetchNewUserKey();
    if (!newToken) return null;

    const expiresAt = now + TTL_MS;
    memKey = newToken;
    memExpiresAt = expiresAt;
    await writeToDb(newToken, expiresAt);
    console.log("Didox: obtained new user-key, valid until", new Date(expiresAt).toISOString());
    return memKey;
  } catch (e) {
    console.error("Didox auth failed:", e.response?.data || e.message);
    return null;
  }
}

async function invalidateUserKey() {
  memKey = null;
  memExpiresAt = 0;
  await writeToDb("", 0);
}

function buildHeaders(userKey) {
  return {
    "Partner-Authorization": PARTNER_TOKEN,
    "user-key": userKey,
    "Content-Type": "application/json",
  };
}

async function getContractStatusByTin(tin) {
  const userKey = await getUserKey();
  if (!userKey) return null;

  try {
    const res = await axios.get(`${BASE}/v2/documents`, {
      params: { owner: 1, partner: tin, doctype: "000", page: 1, limit: 20 },
      headers: buildHeaders(userKey),
    });
    return pickActual(res.data?.data);
  } catch (e) {
    if (e.response?.status === 401) {
      // Token expired — invalidate and retry once
      await invalidateUserKey();
      const uk = await getUserKey();
      if (uk) {
        try {
          const res2 = await axios.get(`${BASE}/v2/documents`, {
            params: { owner: 1, partner: tin, doctype: "000", page: 1, limit: 20 },
            headers: buildHeaders(uk),
          });
          return pickActual(res2.data?.data);
        } catch (e2) {
          console.error("Didox retry failed:", e2.response?.data || e2.message);
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
  const userKey = await getUserKey();
  if (!userKey) return null;
  try {
    const res = await axios.get(
      `https://api.didox.uz/v1/documents/${docId}/pdf/shartnoma`,
      { headers: buildHeaders(userKey), responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  } catch (e) {
    console.error(`Didox downloadContractPdf(${docId}) failed:`, e.message);
    return null;
  }
}

module.exports = { getUserKey, getContractStatusByTin, downloadContractPdf };
