const axios = require("axios");

const BASE = process.env.DIDOX_BASE_URL || "https://api-partners.didox.uz";
const PARTNER_TOKEN = process.env.DIDOX_PARTNER_TOKEN;
const TIN = process.env.DIDOX_TIN;
const PASSWORD = process.env.DIDOX_PASSWORD;

let cachedUserKey = null;
let userKeyExpiresAt = 0;

async function getUserKey() {
  const now = Date.now();
  if (cachedUserKey && now < userKeyExpiresAt) return cachedUserKey;

  if (!PARTNER_TOKEN || !PASSWORD) {
    console.warn("Didox: missing DIDOX_PARTNER_TOKEN or DIDOX_PASSWORD");
    return null;
  }

  try {
    const res = await axios.post(
      `${BASE}/v1/auth/${TIN}/password/ru`,
      { password: PASSWORD },
      { headers: { "Partner-Authorization": PARTNER_TOKEN, "Content-Type": "application/json" } }
    );
    cachedUserKey = res.data?.token;
    userKeyExpiresAt = now + 5 * 60 * 60 * 1000;
    return cachedUserKey;
  } catch (e) {
    console.error("Didox auth failed:", e.response?.data || e.message);
    return null;
  }
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

    const list = (res.data?.data || []).filter(
      (d) => d.doctype === "000" && d.subtype === 3
    );
    if (list.length === 0) return null;

    const actual = list.sort((a, b) => (b.created_unix || 0) - (a.created_unix || 0))[0];
    return extractFields(actual);
  } catch (e) {
    if (e.response?.status === 401) {
      cachedUserKey = null;
      const uk = await getUserKey();
      if (uk) {
        try {
          const res2 = await axios.get(`${BASE}/v2/documents`, {
            params: { owner: 1, partner: tin, doctype: "000", page: 1, limit: 20 },
            headers: buildHeaders(uk),
          });
          const list2 = (res2.data?.data || []).filter((d) => d.doctype === "000" && d.subtype === 3);
          if (list2.length === 0) return null;
          const actual2 = list2.sort((a, b) => (b.created_unix || 0) - (a.created_unix || 0))[0];
          return extractFields(actual2);
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

function extractFields(doc) {
  return {
    doc_id: doc.doc_id,
    doc_status: doc.doc_status,
    contract_number: doc.name || doc.contract_number || null,
    partner_company: doc.partnerCompany || null,
    status_comment: doc.status_comment || null,
    created_unix: doc.created_unix || null,
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
