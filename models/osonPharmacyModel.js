const db = require("../db");

/**
 * Get all OSON pharmacies with optional filters
 * @param {Object} filters - { status, parentRegion, region, search }
 */
async function getAllOsonPharmacies(filters = {}) {
  const { status, parentRegion, region, search } = filters;

  let query = "SELECT * FROM oson_pharmacies WHERE 1=1";
  const params = [];
  let idx = 1;

  if (status && status !== "all") {
    // Check if status is "connected,not_connected" and filter accordingly
    const statusArray = (Array.isArray(status) ? status : status.split(","))
      .map((s) => s.trim())
      .filter((s) => s && s !== "all");

    if (statusArray.length > 0) {
      query += ` AND oson_status = ANY($${idx++})`;
      params.push(statusArray);
    }
  }

  if (parentRegion) {
    const prArray = (Array.isArray(parentRegion) ? parentRegion : parentRegion.split(","))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (prArray.length > 0) {
      query += ` AND (LOWER(parent_region_ru) = ANY($${idx}) OR LOWER(parent_region_uz) = ANY($${idx}))`;
      params.push(prArray);
      idx++;
    }
  }

  if (region) {
    const rArray = (Array.isArray(region) ? region : region.split(","))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (rArray.length > 0) {
      query += ` AND (LOWER(region_ru) = ANY($${idx}) OR LOWER(region_uz) = ANY($${idx}))`;
      params.push(rArray);
      idx++;
    }
  }

  if (search) {
    query += ` AND (LOWER(name_ru) LIKE LOWER($${idx}) OR LOWER(name_uz) LIKE LOWER($${idx}) OR LOWER(address_ru) LIKE LOWER($${idx}) OR slug LIKE LOWER($${idx}))`;
    params.push(`%${search}%`);
    idx++;
  }

  query += " ORDER BY name_ru ASC";

  const result = await db.query(query, params);
  return result.rows;
}

/**
 * Get distinct parent regions for filter dropdown
 */
async function getDistinctParentRegions() {
  const result = await db.query(
    "SELECT DISTINCT parent_region_ru, parent_region_uz FROM oson_pharmacies WHERE parent_region_ru IS NOT NULL ORDER BY parent_region_ru"
  );
  return result.rows;
}

/**
 * Get distinct districts for filter dropdown (optionally filtered by parent region)
 */
async function getDistinctRegions(parentRegion = null) {
  let query =
    "SELECT DISTINCT region_ru, region_uz FROM oson_pharmacies WHERE region_ru IS NOT NULL";
  const params = [];

  if (parentRegion) {
    const prArray = (Array.isArray(parentRegion) ? parentRegion : parentRegion.split(","))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (prArray.length > 0) {
      query +=
        " AND (LOWER(parent_region_ru) = ANY($1) OR LOWER(parent_region_uz) = ANY($1))";
      params.push(prArray);
    }
  }

  query += " ORDER BY region_ru";
  const result = await db.query(query, params);
  return result.rows;
}

/**
 * Get a single pharmacy by slug
 */
async function getPharmacyBySlug(slug) {
  const result = await db.query(
    "SELECT * FROM oson_pharmacies WHERE slug = $1",
    [slug]
  );
  return result.rows[0] || null;
}

/**
 * Upsert (INSERT or UPDATE) a pharmacy record by slug
 * Does NOT overwrite oson_status if already set to 'connected' or 'deleted'
 * newStatus is the proposed new status ('connected' or 'not_connected')
 */
async function upsertPharmacy(slug, data, newStatus) {
  const {
    name_ru,
    name_uz,
    parent_region_ru,
    parent_region_uz,
    region_ru,
    region_uz,
    address_ru,
    address_uz,
    landmark_ru,
    landmark_uz,
    latitude,
    longitude,
    phone,
    open_time,
    close_time,
    has_delivery,
    is_verified,
    discount_percent,
    cashback_percent,
  } = data;

  // On conflict: update data fields and last_synced_at
  // Status update logic handled separately via updateStatus()
  const query = `
    INSERT INTO oson_pharmacies (
      slug, name_ru, name_uz, parent_region_ru, parent_region_uz,
      region_ru, region_uz, address_ru, address_uz, landmark_ru, landmark_uz,
      latitude, longitude, phone, open_time, close_time,
      has_delivery, is_verified, discount_percent, cashback_percent,
      oson_status, last_synced_at, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, NOW(), NOW()
    )
    ON CONFLICT (slug) DO UPDATE SET
      name_ru = EXCLUDED.name_ru,
      name_uz = EXCLUDED.name_uz,
      parent_region_ru = EXCLUDED.parent_region_ru,
      parent_region_uz = EXCLUDED.parent_region_uz,
      region_ru = EXCLUDED.region_ru,
      region_uz = EXCLUDED.region_uz,
      address_ru = EXCLUDED.address_ru,
      address_uz = EXCLUDED.address_uz,
      landmark_ru = EXCLUDED.landmark_ru,
      landmark_uz = EXCLUDED.landmark_uz,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      phone = EXCLUDED.phone,
      open_time = EXCLUDED.open_time,
      close_time = EXCLUDED.close_time,
      has_delivery = EXCLUDED.has_delivery,
      is_verified = EXCLUDED.is_verified,
      discount_percent = EXCLUDED.discount_percent,
      cashback_percent = EXCLUDED.cashback_percent,
      last_synced_at = NOW()
    RETURNING *;
  `;

  const result = await db.query(query, [
    slug,
    name_ru,
    name_uz,
    parent_region_ru,
    parent_region_uz,
    region_ru,
    region_uz,
    address_ru,
    address_uz,
    landmark_ru,
    landmark_uz,
    latitude,
    longitude,
    phone,
    open_time,
    close_time,
    has_delivery,
    is_verified,
    discount_percent,
    cashback_percent,
    newStatus,
  ]);

  return result.rows[0];
}

/**
 * Update only the oson_status of a pharmacy
 */
async function updateStatus(slug, newStatus) {
  const result = await db.query(
    "UPDATE oson_pharmacies SET oson_status = $1, last_synced_at = NOW() WHERE slug = $2 RETURNING *",
    [newStatus, slug]
  );
  return result.rows[0];
}

/**
 * Delete a pharmacy by slug (used for 'not_connected' ones that disappeared from OSON)
 */
async function deletePharmacy(slug) {
  await db.query("DELETE FROM oson_pharmacies WHERE slug = $1", [slug]);
}

/**
 * Get all slugs currently in the DB
 */
async function getAllSlugsWithStatus() {
  const result = await db.query(
    "SELECT slug, oson_status FROM oson_pharmacies"
  );
  const map = new Map();
  result.rows.forEach((r) => map.set(r.slug, r.oson_status));
  return map;
}

/**
 * Get sync stats summary
 */
async function getSyncStats() {
  const result = await db.query(`
    SELECT 
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE oson_status = 'connected') AS connected,
      COUNT(*) FILTER (WHERE oson_status = 'not_connected') AS not_connected,
      COUNT(*) FILTER (WHERE oson_status = 'deleted') AS deleted,
      MAX(last_synced_at) AS last_synced_at
    FROM oson_pharmacies
  `);
  return result.rows[0];
}

module.exports = {
  getAllOsonPharmacies,
  getDistinctParentRegions,
  getDistinctRegions,
  getPharmacyBySlug,
  upsertPharmacy,
  updateStatus,
  deletePharmacy,
  getAllSlugsWithStatus,
  getSyncStats,
};
