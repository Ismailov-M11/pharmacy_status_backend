const db = require("../db");

// ─── Filters ───────────────────────────────────────────────────────────────────
function buildWhere(filters) {
  const { search, status, pharmacies, sources, dateFrom, dateTo, itemsMin, itemsMax, totalMin, totalMax, promoCode } = filters;
  let where = "WHERE 1=1";
  const params = [];
  let idx = 1;

  if (status && status !== "all") {
    where += ` AND cart_status = $${idx++}`;
    params.push(status);
  }
  if (dateFrom) {
    where += ` AND creation_date >= $${idx++}`;
    params.push(new Date(dateFrom));
  }
  if (dateTo) {
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);
    where += ` AND creation_date <= $${idx++}`;
    params.push(to);
  }
  if (pharmacies && pharmacies.length) {
    where += ` AND market_name = ANY($${idx++})`;
    params.push(pharmacies);
  }
  if (sources && sources.length) {
    where += ` AND source = ANY($${idx++})`;
    params.push(sources);
  }
  if (itemsMin) {
    where += ` AND jsonb_array_length(items) >= $${idx++}`;
    params.push(parseInt(itemsMin));
  }
  if (itemsMax) {
    where += ` AND jsonb_array_length(items) <= $${idx++}`;
    params.push(parseInt(itemsMax));
  }
  if (totalMin) {
    where += ` AND invoice_total >= $${idx++}`;
    params.push(parseFloat(totalMin));
  }
  if (totalMax) {
    where += ` AND invoice_total <= $${idx++}`;
    params.push(parseFloat(totalMax));
  }
  if (promoCode) {
    where += ` AND LOWER(invoice_promo_code) LIKE LOWER($${idx++})`;
    params.push(`%${promoCode}%`);
  }
  if (search) {
    const q = `%${search}%`;
    where += ` AND (
      CAST(id AS TEXT) LIKE $${idx} OR
      customer_phone ILIKE $${idx} OR
      customer_first_name ILIKE $${idx} OR
      customer_last_name ILIKE $${idx} OR
      market_name ILIKE $${idx} OR
      market_address ILIKE $${idx} OR
      items::TEXT ILIKE $${idx} OR
      invoice_promo_code ILIKE $${idx}
    )`;
    params.push(q);
    idx++;
  }

  return { where, params, nextIdx: idx };
}

const SELECT_COLS = `
  id, creation_date, modified_date, created_by,
  customer_id, customer_first_name, customer_last_name, customer_phone,
  market_id, market_name, market_address, market_landmark, market_phone,
  market_latitude::float, market_longitude::float, market_slug,
  items,
  invoice_id, invoice_market_total::float, invoice_delivery_total::float,
  invoice_service_total::float, invoice_total::float, invoice_paid, invoice_promo_code,
  source, latitude::float, longitude::float,
  cart_status, comment, comment_by, comment_at,
  last_synced_at
`;

async function getCartsPaginated(filters = {}, page = 0, size = 50) {
  const { where, params, nextIdx } = buildWhere(filters);

  const countResult = await db.query(
    `SELECT COUNT(*) AS total FROM user_carts ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].total) || 0;

  const dataResult = await db.query(
    `SELECT ${SELECT_COLS} FROM user_carts ${where}
     ORDER BY creation_date DESC
     LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
    [...params, size, page * size]
  );

  return { data: dataResult.rows, total };
}

async function getAllCarts(filters = {}) {
  const { where, params } = buildWhere(filters);
  const result = await db.query(
    `SELECT ${SELECT_COLS} FROM user_carts ${where} ORDER BY creation_date DESC`,
    params
  );
  return result.rows;
}

async function upsertCart(cart) {
  const query = `
    INSERT INTO user_carts (
      id, creation_date, modified_date, created_by,
      customer_id, customer_first_name, customer_last_name, customer_phone,
      market_id, market_name, market_address, market_landmark, market_phone,
      market_latitude, market_longitude, market_slug,
      items,
      invoice_id, invoice_market_total, invoice_delivery_total,
      invoice_service_total, invoice_total, invoice_paid, invoice_promo_code,
      source, latitude, longitude,
      last_synced_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
      $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
      $25,$26,$27, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      creation_date         = EXCLUDED.creation_date,
      modified_date         = EXCLUDED.modified_date,
      created_by            = EXCLUDED.created_by,
      customer_id           = EXCLUDED.customer_id,
      customer_first_name   = EXCLUDED.customer_first_name,
      customer_last_name    = EXCLUDED.customer_last_name,
      customer_phone        = EXCLUDED.customer_phone,
      market_id             = EXCLUDED.market_id,
      market_name           = EXCLUDED.market_name,
      market_address        = EXCLUDED.market_address,
      market_landmark       = EXCLUDED.market_landmark,
      market_phone          = EXCLUDED.market_phone,
      market_latitude       = EXCLUDED.market_latitude,
      market_longitude      = EXCLUDED.market_longitude,
      market_slug           = EXCLUDED.market_slug,
      items                 = EXCLUDED.items,
      invoice_id            = EXCLUDED.invoice_id,
      invoice_market_total  = EXCLUDED.invoice_market_total,
      invoice_delivery_total= EXCLUDED.invoice_delivery_total,
      invoice_service_total = EXCLUDED.invoice_service_total,
      invoice_total         = EXCLUDED.invoice_total,
      invoice_paid          = EXCLUDED.invoice_paid,
      invoice_promo_code    = EXCLUDED.invoice_promo_code,
      source                = EXCLUDED.source,
      latitude              = EXCLUDED.latitude,
      longitude             = EXCLUDED.longitude,
      last_synced_at        = NOW()
  `;

  const c = cart;
  await db.query(query, [
    c.id,
    c.creationDate,
    c.modifiedDate,
    c.createdBy,
    c.customer?.id ?? null,
    c.customer?.firstName ?? null,
    c.customer?.lastName ?? null,
    c.customer?.phone ?? null,
    c.market?.id ?? null,
    c.market?.name ?? null,
    c.market?.address ?? null,
    c.market?.landmark ?? null,
    c.market?.phone ?? null,
    c.market?.latitude ?? null,
    c.market?.longitude ?? null,
    c.market?.slug ?? null,
    JSON.stringify(c.items ?? []),
    c.invoice?.id ?? null,
    c.invoice?.marketTotal ?? 0,
    c.invoice?.deliveryTotal ?? 0,
    c.invoice?.serviceTotal ?? 0,
    c.invoice?.total ?? 0,
    c.invoice?.paid ?? false,
    c.invoice?.promoCode?.code ?? null,
    c.source ?? null,
    c.latitude ?? null,
    c.longitude ?? null,
  ]);
}

async function updateComment(id, comment, commentBy) {
  const status = comment && comment.trim() ? "processed" : "unprocessed";
  const result = await db.query(
    `UPDATE user_carts
     SET comment = $1, comment_by = $2, comment_at = $3, cart_status = $4
     WHERE id = $5
     RETURNING ${SELECT_COLS}`,
    [
      comment || null,
      comment && comment.trim() ? commentBy : null,
      comment && comment.trim() ? new Date() : null,
      status,
      id,
    ]
  );
  return result.rows[0] || null;
}

// ─── Comment history ───────────────────────────────────────────────────────────
async function getComments(cartId) {
  const r = await db.query(
    `SELECT id, cart_id, text, created_by, created_at
     FROM user_cart_comments
     WHERE cart_id = $1
     ORDER BY created_at ASC`,
    [cartId]
  );
  return r.rows;
}

async function addComment(cartId, text, createdBy, status) {
  if (!text || !text.trim()) throw new Error("Comment text required");
  const validStatuses = ["unprocessed", "processed", "missed_call"];
  const cartStatus = validStatuses.includes(status) ? status : "processed";

  const inserted = await db.query(
    `INSERT INTO user_cart_comments (cart_id, text, created_by, created_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id, cart_id, text, created_by, created_at`,
    [cartId, text.trim(), createdBy]
  );

  await db.query(
    `UPDATE user_carts
     SET comment = $1, comment_by = $2, comment_at = NOW(), cart_status = $3
     WHERE id = $4`,
    [text.trim(), createdBy, cartStatus, cartId]
  );

  return inserted.rows[0];
}

async function getSyncStats() {
  const result = await db.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE cart_status = 'unprocessed') AS unprocessed,
      COUNT(*) FILTER (WHERE cart_status = 'processed')   AS processed,
      MAX(last_synced_at) AS last_synced_at
    FROM user_carts
  `);
  return result.rows[0];
}

async function getDistinctPharmacies() {
  const r = await db.query(
    "SELECT DISTINCT market_name FROM user_carts WHERE market_name IS NOT NULL ORDER BY market_name"
  );
  return r.rows.map((x) => x.market_name);
}

async function getDistinctSources() {
  const r = await db.query(
    "SELECT DISTINCT source FROM user_carts WHERE source IS NOT NULL ORDER BY source"
  );
  return r.rows.map((x) => x.source);
}

async function getDistinctCommentUsers() {
  const r = await db.query(
    "SELECT DISTINCT comment_by FROM user_carts WHERE comment_by IS NOT NULL ORDER BY comment_by"
  );
  return r.rows.map((x) => x.comment_by);
}

const STATUS_COLORS = ["blue","purple","red","pink","cyan","teal","indigo","violet","rose","sky","lime","amber","slate","emerald","fuchsia"];

async function getStatuses() {
  const r = await db.query("SELECT * FROM cart_statuses ORDER BY created_at ASC");
  return r.rows;
}

async function createStatus(label, createdBy) {
  const color = STATUS_COLORS[Math.floor(Math.random() * STATUS_COLORS.length)];
  const value = "custom_" + Date.now();
  const r = await db.query(
    `INSERT INTO cart_statuses (value, label, color, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [value, label.trim(), color, createdBy]
  );
  return r.rows[0];
}

module.exports = {
  getCartsPaginated,
  getAllCarts,
  upsertCart,
  updateComment,
  getComments,
  addComment,
  getSyncStats,
  getDistinctPharmacies,
  getDistinctSources,
  getDistinctCommentUsers,
  getStatuses,
  createStatus,
};
