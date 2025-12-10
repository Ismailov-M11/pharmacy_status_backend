const db = require("../db");

async function getOrCreatePharmacyStatus(pharmacy_id) {
  const result = await db.query(
    "SELECT * FROM pharmacy_status WHERE pharmacy_id = $1",
    [pharmacy_id]
  );

  if (result.rows.length === 0) {
    await db.query(
      "INSERT INTO pharmacy_status (pharmacy_id) VALUES ($1)",
      [pharmacy_id]
    );

    return {
      pharmacy_id,
      training: false,
      brandedPacket: false
    };
  }

  return result.rows[0];
}

async function updatePharmacyStatus(pharmacy_id, field, new_value) {
  const query = `
    UPDATE pharmacy_status
    SET "${field}" = $1, updated_at = NOW()
    WHERE pharmacy_id = $2
    RETURNING *;
  `;

  const result = await db.query(query, [new_value, pharmacy_id]);
  return result.rows[0];
}

module.exports = {
  getOrCreatePharmacyStatus,
  updatePharmacyStatus
};
