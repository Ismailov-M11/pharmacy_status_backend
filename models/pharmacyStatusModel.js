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
  // Use UPSERT: INSERT if not exists, UPDATE if exists
  const query = `
    INSERT INTO pharmacy_status (pharmacy_id, ${field}, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (pharmacy_id)
    DO UPDATE SET ${field} = $2, updated_at = NOW()
    RETURNING *;
  `;

  const result = await db.query(query, [pharmacy_id, new_value]);
  return result.rows[0];
}

module.exports = {
  getOrCreatePharmacyStatus,
  updatePharmacyStatus
};
