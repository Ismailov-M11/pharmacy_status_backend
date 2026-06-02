const axios = require("axios");
const db = require("../db");

const DAVO_API = "https://api.davodelivery.uz/api";
const SESSION_CONCURRENCY = 30; // parallel session-list calls per chunk

function toContractApi(row) {
  const map = {
    1: { status: "pending",  label: "Ожидает",  color: "amber" },
    3: { status: "signed",   label: "Подписан", color: "emerald" },
    4: { status: "rejected", label: "Отказан",  color: "red" },
  };
  const meta = map[row.doc_status] || { status: "none", label: "Нет договора", color: "gray" };
  return {
    tin: row.tin,
    doc_id: row.doc_id || null,
    doc_status: row.doc_status ?? null,
    contract_number: row.contract_number || null,
    status_comment: row.status_comment || null,
    ...meta,
  };
}

// POST /api/batch/pharmacy-data
// Body: { items: [{marketId: number|null, tin: string|null}] }
// Header: Authorization: Bearer <davo-token>
async function getPharmacyBatchData(req, res) {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({});
    }

    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");

    const marketIds = [...new Set(items.map(i => String(i.marketId)).filter(Boolean))];
    const tins = [...new Set(items.map(i => i.tin).filter(Boolean))];

    // ── 1. Batch: training + brandedPacket from pharmacy_status ──────────────
    const statusMap = {};
    if (marketIds.length) {
      const r = await db.query(
        "SELECT pharmacy_id, training, branded_packet FROM pharmacy_status WHERE pharmacy_id = ANY($1)",
        [marketIds]
      );
      r.rows.forEach(row => {
        statusMap[row.pharmacy_id] = {
          training: row.training || false,
          brandedPacket: row.branded_packet || false,
        };
      });
    }

    // ── 2. Batch: contract status from pharmacy_contracts ────────────────────
    const contractMap = {};
    if (tins.length) {
      const r = await db.query(
        "SELECT * FROM pharmacy_contracts WHERE tin = ANY($1) AND doc_id IS NOT NULL",
        [tins]
      );
      r.rows.forEach(row => {
        contractMap[row.tin] = toContractApi(row);
      });
    }

    // ── 3. Session-list: proxy to Davo API in parallel chunks ────────────────
    const sessionMap = {};
    const itemsWithMarket = items.filter(i => i.marketId);

    if (token && itemsWithMarket.length) {
      for (let i = 0; i < itemsWithMarket.length; i += SESSION_CONCURRENCY) {
        const chunk = itemsWithMarket.slice(i, i + SESSION_CONCURRENCY);
        await Promise.all(chunk.map(async item => {
          try {
            const r = await axios.post(
              `${DAVO_API}/market/session-list`,
              { marketId: item.marketId },
              {
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                timeout: 8000,
              }
            );
            const list = r.data?.payload?.list || [];
            sessionMap[item.marketId] = list.some(s => s.active === true);
          } catch {
            sessionMap[item.marketId] = false;
          }
        }));
      }
    }

    // ── 4. Merge all results keyed by marketId ───────────────────────────────
    const result = {};
    for (const item of items) {
      if (!item.marketId) continue;
      const status = statusMap[String(item.marketId)] || { training: false, brandedPacket: false };
      result[item.marketId] = {
        training: status.training,
        brandedPacket: status.brandedPacket,
        merchantOnline: sessionMap[item.marketId] || false,
        davoContract: contractMap[item.tin] || null,
      };
    }

    return res.json(result);
  } catch (e) {
    console.error("batchController error:", e.message);
    return res.status(500).json({ error: "Batch fetch failed" });
  }
}

module.exports = { getPharmacyBatchData };
