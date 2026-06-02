const axios = require("axios");
const db = require("../db");
const didox = require("../services/didoxService");
const contractModel = require("../models/contractModel");

const DAVO_API = "https://api.davodelivery.uz/api";
const SESSION_CONCURRENCY = 30;

function toContractApi(row) {
  if (!row) return null;
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

// Фоновое обновление кэша для TIN-ов без записи или с doc_id=null.
// Запускается после ответа клиенту (fire-and-forget).
function refreshStaleContractsAsync(tins) {
  if (!tins.length) return;
  setImmediate(async () => {
    for (const tin of tins) {
      try {
        const fresh = await didox.getContractStatusByTin(tin);
        await contractModel.upsertContract(tin, fresh);
      } catch {
        // ignore — next cron will retry
      }
      // небольшая пауза между запросами чтобы не триггерить 429
      await new Promise(r => setTimeout(r, 300));
    }
  });
}

// POST /api/batch/pharmacy-data
// Body: { items: [{marketId, tin}], refresh?: boolean }
// Header: Authorization: Bearer <davo-token>
async function getPharmacyBatchData(req, res) {
  try {
    const { items, refresh = false } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({});
    }

    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const marketIds = [...new Set(items.map(i => String(i.marketId)).filter(Boolean))];
    const tins = [...new Set(
      items.map(i => i.tin ? String(i.tin).replace(/\s+/g, "") : null).filter(Boolean)
    )];
    // Нормализуем TIN в самих items тоже
    items = items.map(i => ({
      ...i,
      tin: i.tin ? String(i.tin).replace(/\s+/g, "") : null,
    }));

    // ── 1. training + brandedPacket ──────────────────────────────────────────
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

    // ── 2. Contracts from cache ──────────────────────────────────────────────
    const contractMap = {};
    const tinsNeedingRefresh = [];

    if (tins.length) {
      const r = await db.query(
        "SELECT * FROM pharmacy_contracts WHERE tin = ANY($1)",
        [tins]
      );

      // Порог устаревания: обновляем если данные старше 30 минут
      const STALE_MS = 30 * 60 * 1000;
      const now = Date.now();

      r.rows.forEach(row => {
        const isStale = !row.last_checked_at ||
          (now - new Date(row.last_checked_at).getTime()) > STALE_MS;

        if (row.doc_id) {
          contractMap[row.tin] = toContractApi(row);
          // Если принудительное обновление или данные устарели — перепроверим фоне
          if (refresh || isStale) tinsNeedingRefresh.push(row.tin);
        } else {
          // doc_id=null — нет реального договора, всегда перепроверяем фоново
          tinsNeedingRefresh.push(row.tin);
        }
      });

      // TIN-ы которых вообще нет в таблице
      const cachedTins = new Set(r.rows.map(row => row.tin));
      tins.forEach(tin => {
        if (!cachedTins.has(tin)) tinsNeedingRefresh.push(tin);
      });
    }

    // ── 3. Session-list (прокси к Davo API) ──────────────────────────────────
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

    // ── 4. Merge ─────────────────────────────────────────────────────────────
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

    // Отвечаем клиенту сразу, затем обновляем устаревшие/отсутствующие TIN-ы
    res.json(result);
    refreshStaleContractsAsync([...new Set(tinsNeedingRefresh)]);

  } catch (e) {
    console.error("[Batch] error:", e.message);
    return res.status(500).json({ error: "Batch fetch failed" });
  }
}

module.exports = { getPharmacyBatchData };
