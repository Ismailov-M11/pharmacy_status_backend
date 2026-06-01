const db = require("../db");

async function upsertContract(tin, c) {
  const q = `
    INSERT INTO pharmacy_contracts
      (tin, doc_id, doc_status, contract_number, partner_company, status_comment, created_unix, last_checked_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
    ON CONFLICT (tin) DO UPDATE SET
      doc_id = $2, doc_status = $3, contract_number = $4,
      partner_company = $5, status_comment = $6, created_unix = $7,
      last_checked_at = NOW(), updated_at = NOW()
    RETURNING *;
  `;
  const r = await db.query(q, [
    tin,
    c?.doc_id || null,
    c?.doc_status ?? null,
    c?.contract_number || null,
    c?.partner_company || null,
    c?.status_comment || null,
    c?.created_unix || null,
  ]);
  return r.rows[0];
}

async function getContractByTin(tin) {
  const r = await db.query("SELECT * FROM pharmacy_contracts WHERE tin = $1", [tin]);
  return r.rows[0] || null;
}

async function getAllContracts() {
  const r = await db.query("SELECT * FROM pharmacy_contracts");
  return r.rows;
}

module.exports = { upsertContract, getContractByTin, getAllContracts };
