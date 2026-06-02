const didox = require("../services/didoxService");
const contractModel = require("../models/contractModel");

// GET /api/contracts/:tin  — contract status (from cache; ?refresh=1 forces Didox fetch)
async function getContract(req, res) {
  const { tin } = req.params;
  const { refresh } = req.query;

  try {
    if (refresh === "1") {
      const fresh = await didox.getContractStatusByTin(tin);
      const saved = await contractModel.upsertContract(tin, fresh);
      return res.json(toApi(saved));
    }

    const cached = await contractModel.getContractByTin(tin);
    // Serve cache only if we actually have a real contract (doc_id present)
    if (cached?.doc_id) return res.json(toApi(cached));

    // No cache, or cached as "no contract" — always re-fetch from Didox
    const fresh = await didox.getContractStatusByTin(tin);
    const saved = await contractModel.upsertContract(tin, fresh);
    return res.json(toApi(saved));
  } catch (e) {
    console.error("getContract error:", e.message);
    return res.status(500).json({ error: "Failed to get contract status" });
  }
}

// GET /api/contracts/:tin/links — ready-made Download/Copy URLs
async function getContractLinks(req, res) {
  const { tin } = req.params;
  try {
    const cached = await contractModel.getContractByTin(tin);
    if (!cached || !cached.doc_id) {
      return res.json({ doc_id: null, downloadUrl: null, copyUrl: null });
    }
    res.json({
      doc_id: cached.doc_id,
      downloadUrl: `/api/contracts/${encodeURIComponent(tin)}/pdf`,
      copyUrl: `https://api.didox.uz/v1/documents/${cached.doc_id}/pdf/shartnoma`,
    });
  } catch (e) {
    console.error("getContractLinks error:", e.message);
    return res.status(500).json({ error: "Failed to get contract links" });
  }
}

// GET /api/contracts/:tin/pdf — backend proxy for PDF download
async function downloadPdf(req, res) {
  const { tin } = req.params;
  try {
    const cached = await contractModel.getContractByTin(tin);
    if (!cached || !cached.doc_id) {
      return res.status(404).json({ error: "No contract found" });
    }

    const pdf = await didox.downloadContractPdf(cached.doc_id);
    if (!pdf) return res.status(502).json({ error: "Failed to fetch PDF from Didox" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="contract-${cached.contract_number || tin}.pdf"`
    );
    res.send(pdf);
  } catch (e) {
    console.error("downloadPdf error:", e.message);
    return res.status(500).json({ error: "Failed to download PDF" });
  }
}

function toApi(row) {
  const map = {
    1: { status: "pending",  label: "Ожидает",  color: "amber" },
    3: { status: "signed",   label: "Подписан", color: "emerald" },
    4: { status: "rejected", label: "Отказан",  color: "red" },
  };
  const meta = map[row?.doc_status] || { status: "none", label: "Нет договора", color: "gray" };
  return {
    tin: row?.tin,
    doc_id: row?.doc_id || null,
    doc_status: row?.doc_status ?? null,
    contract_number: row?.contract_number || null,
    status_comment: row?.status_comment || null,
    ...meta,
  };
}

module.exports = { getContract, getContractLinks, downloadPdf };
