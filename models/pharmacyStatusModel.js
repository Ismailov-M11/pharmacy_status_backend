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

  // Convert snake_case to camelCase for frontend
  const row = result.rows[0];
  return {
    ...row,
    brandedPacket: row.branded_packet
  };
}

async function updatePharmacyStatus(pharmacy_id, field, new_value) {
  // Convert camelCase to snake_case for database column names
  const dbField = field === 'brandedPacket' ? 'branded_packet' : field;

  // Use UPSERT: INSERT if not exists, UPDATE if exists
  const query = `
    INSERT INTO pharmacy_status (pharmacy_id, ${dbField}, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (pharmacy_id)
    DO UPDATE SET ${dbField} = $2, updated_at = NOW()
    RETURNING *;
  `;

  // Note: For is_active or timestamps, we might need to preserve other fields, 
  // but ON CONFLICT ... DO UPDATE only touches the specified field + updated_at. 
  // The INSERT case implies other fields get defaults. This works.

  try {
    const result = await db.query(query, [pharmacy_id, new_value]);
    const row = result.rows[0];
    return {
      ...row,
      brandedPacket: row.branded_packet
    };
  } catch (e) {
    // If column doesn't exist or other error
    throw e;
  }
}

async function updatePharmacyTimestamp(pharmacy_id, field) {
  const query = `
    UPDATE pharmacy_status 
    SET ${field} = NOW(), updated_at = NOW()
    WHERE pharmacy_id = $1
    RETURNING *
  `;
  await db.query(query, [pharmacy_id]);
}

async function logActivityEvent(pharmacy_id, event_type, source, meta = null) {
  const query = `
    INSERT INTO pharmacy_activity_events (pharmacy_id, event_type, source, meta)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  await db.query(query, [pharmacy_id, event_type, source, meta]);
}

async function getPharmaciesByDateRange(fromDate, toDate) {
  // Use onboarded_at for "New Pharmacies" report
  const query = `
    SELECT * FROM pharmacy_status 
    WHERE onboarded_at >= $1 AND onboarded_at <= $2
    ORDER BY onboarded_at DESC
  `;
  const result = await db.query(query, [fromDate, toDate]);

  return result.rows.map(row => ({
    ...row,
    brandedPacket: row.branded_packet,
    // Return onboardedAt for the report
    onboardedAt: row.onboarded_at,
    currentStatus: row.is_active ? 'active' : 'inactive'
  }));
}

async function getActivityEventsByDateRange(fromDate, toDate) {
  const query = `
    SELECT e.*, p.is_active as current_status
    FROM pharmacy_activity_events e
    LEFT JOIN pharmacy_status p ON e.pharmacy_id = p.pharmacy_id
    WHERE e.event_at >= $1 AND e.event_at <= $2
    ORDER BY e.event_at DESC
  `;
  const result = await db.query(query, [fromDate, toDate]);

  return result.rows.map(row => ({
    ...row,
    changeDatetime: row.event_at,
    type: row.event_type,
    currentStatus: row.current_status ? 'active' : 'inactive'
  }));
}

module.exports = {
  getOrCreatePharmacyStatus,
  updatePharmacyStatus,
  updatePharmacyTimestamp,
  logActivityEvent,
  getPharmaciesByDateRange,
  getActivityEventsByDateRange
};
