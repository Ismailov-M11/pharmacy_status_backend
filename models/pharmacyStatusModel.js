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
  // Convert camelCase to snake_case for database column names
  const dbField = field === 'brandedPacket' ? 'branded_packet' : field;

  // Use UPSERT: INSERT if not exists, UPDATE if exists
  // We need to handle both fields separately to avoid SQL injection
  let query;
  if (dbField === 'training') {
    query = `
      INSERT INTO pharmacy_status (pharmacy_id, training, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (pharmacy_id)
      DO UPDATE SET training = $2, updated_at = NOW()
      RETURNING *;
    `;
  } else if (dbField === 'branded_packet') {
    query = `
      INSERT INTO pharmacy_status (pharmacy_id, branded_packet, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (pharmacy_id)
      DO UPDATE SET branded_packet = $2, updated_at = NOW()
      RETURNING *;
    `;
  } else {
    throw new Error(`Invalid field: ${field}`);
  }

  const result = await db.query(query, [pharmacy_id, new_value]);
  return result.rows[0];
}

module.exports = {
  getOrCreatePharmacyStatus,
  updatePharmacyStatus
};
