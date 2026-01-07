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
      brandedPacket: false,
      last_active: true // default
    };
  }

  // Convert snake_case to camelCase for frontend where needed
  const row = result.rows[0];
  return {
    ...row,
    brandedPacket: row.branded_packet,
    is_active: row.last_active, // Compatibility alias for controller logic
    onboarding_started_at: row.first_deactivated_at, // Compatibility alias
    onboarded_at: row.first_trained_activation_at // Compatibility alias
  };
}

async function updatePharmacyStatus(pharmacy_id, field, new_value) {
  // Convert camelCase to snake_case for database column names
  let dbField = field;
  if (field === 'brandedPacket') dbField = 'branded_packet';
  // Map legacy fields to new schema if strict logic uses them
  if (field === 'is_active') dbField = 'last_active';

  // Use UPSERT: INSERT if not exists, UPDATE if exists
  const query = `
    INSERT INTO pharmacy_status (pharmacy_id, ${dbField}, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (pharmacy_id)
    DO UPDATE SET ${dbField} = $2, updated_at = NOW()
    RETURNING *;
  `;

  try {
    const result = await db.query(query, [pharmacy_id, new_value]);
    const row = result.rows[0];
    return {
      ...row,
      brandedPacket: row.branded_packet,
      // map back to old prop for potential legacy compatibility if needed, but better use new names
      last_active: row.last_active
    };
  } catch (e) {
    throw e;
  }
}

async function updatePharmacyTimestamp(pharmacy_id, field) {
  // Map old field request to new column
  let column = field;
  if (field === 'onboarding_started_at') column = 'first_deactivated_at';
  if (field === 'onboarded_at') column = 'first_trained_activation_at';

  const query = `
    UPDATE pharmacy_status 
    SET ${column} = NOW(), updated_at = NOW()
    WHERE pharmacy_id = $1
    RETURNING *
  `;
  await db.query(query, [pharmacy_id]);
}

async function logActivityEvent(pharmacy_id, event_type, source, meta = null) {
  const query = `
    INSERT INTO pharmacy_events (pharmacy_id, event_type, source, meta)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  await db.query(query, [pharmacy_id, event_type, source, meta]);
}

async function getPharmaciesByDateRange(fromDate, toDate) {
  // Use first_trained_activation_at for "New Pharmacies" report
  const query = `
    SELECT * FROM pharmacy_status 
    WHERE first_trained_activation_at >= $1 AND first_trained_activation_at <= $2
    ORDER BY first_trained_activation_at DESC
  `;
  const result = await db.query(query, [fromDate, toDate]);

  return result.rows.map(row => ({
    ...row,
    brandedPacket: row.branded_packet,
    onboardedAt: row.first_trained_activation_at,
    currentStatus: row.last_active ? 'active' : 'inactive'
  }));
}

async function getActivityEventsByDateRange(fromDate, toDate) {
  const query = `
    SELECT e.*, p.last_active as current_status
    FROM pharmacy_events e
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
