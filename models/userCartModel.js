const db = require("../db");

// ─── Filters ───────────────────────────────────────────────────────────────────
function buildWhere(filters) {
  const { search, status, pharmacies, sources, dateFrom, dateTo, itemsMin, itemsMax, totalMin, totalMax, promoCode, historyStatuses, historyDateFrom, historyDateTo } = filters;
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
  if (historyStatuses && historyStatuses.length) {
    let subWhere = `h.status = ANY($${idx++})`;
    params.push(historyStatuses);
    if (historyDateFrom) {
      subWhere += ` AND h.created_at >= $${idx++}`;
      params.push(new Date(historyDateFrom));
    }
    if (historyDateTo) {
      const to = new Date(historyDateTo);
      to.setHours(23, 59, 59, 999);
      subWhere += ` AND h.created_at <= $${idx++}`;
      params.push(to);
    }
    where += ` AND id IN (SELECT DISTINCT cart_id FROM user_cart_comments h WHERE ${subWhere})`;
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
  last_synced_at, order_status, order_status_synced_at, order_code
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
    `SELECT ${SELECT_COLS},
       cc.claimed_by AS claimed_by,
       cc.claimed_at AS claimed_at
     FROM user_carts
     LEFT JOIN customer_claims cc
       ON cc.customer_phone = user_carts.customer_phone
       AND cc.claimed_at > NOW() - INTERVAL '15 minutes'
     ${where}
     ORDER BY creation_date DESC`,
    params
  );
  return result.rows;
}

async function upsertCart(cart) {
  const c = cart;
  const isDeleted = c.deleted === true || c.isDeleted === true;
  const invoiceId = c.invoice?.id ?? null;
  // New carts start as pending; order sync sets in_progress/delivered/cancelled
  const initialOrderStatus = isDeleted ? 'deleted' : 'pending';

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
      order_status, last_synced_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
      $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
      $25,$26,$27,$28, NOW()
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
      order_status          = CASE
        WHEN $28 = 'deleted' THEN 'deleted'
        WHEN user_carts.order_status IN ('delivered', 'cancelled', 'deleted') THEN user_carts.order_status
        ELSE user_carts.order_status
      END,
      last_synced_at        = NOW()
  `;

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
    invoiceId,
    c.invoice?.marketTotal ?? 0,
    c.invoice?.deliveryTotal ?? 0,
    c.invoice?.serviceTotal ?? 0,
    c.invoice?.total ?? 0,
    c.invoice?.paid ?? false,
    c.invoice?.promoCode?.code ?? null,
    c.source ?? null,
    c.latitude ?? null,
    c.longitude ?? null,
    initialOrderStatus,
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
    `SELECT id, cart_id, NULLIF(text, '') AS text, created_by, created_at, status
     FROM user_cart_comments
     WHERE cart_id = $1
     ORDER BY created_at ASC`,
    [cartId]
  );
  return r.rows;
}

async function addComment(cartId, text, createdBy, status) {
  // text is optional — status change alone is allowed
  if (!status) throw new Error("Status required");

  // Validate status against cart_statuses table; fallback to 'processed'
  const statusCheck = await db.query("SELECT value FROM cart_statuses WHERE value = $1", [status]);
  const cartStatus = statusCheck.rows.length > 0 ? status : "processed";

  const trimmedText = text && text.trim() ? text.trim() : null;

  const inserted = await db.query(
    `INSERT INTO user_cart_comments (cart_id, text, created_by, created_at, status)
     VALUES ($1, COALESCE($2, ''), $3, NOW(), $4)
     RETURNING id, cart_id, NULLIF(text, '') AS text, created_by, created_at, status`,
    [cartId, trimmedText, createdBy, cartStatus]
  );

  if (trimmedText) {
    // Update cart comment + status when text is provided
    await db.query(
      `UPDATE user_carts SET comment = $1, comment_by = $2, comment_at = NOW(), cart_status = $3 WHERE id = $4`,
      [trimmedText, createdBy, cartStatus, cartId]
    );
  } else {
    // Status-only change — don't overwrite existing comment text
    await db.query(
      `UPDATE user_carts SET cart_status = $1 WHERE id = $2`,
      [cartStatus, cartId]
    );
  }

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

async function markMissingCartsDeleted(syncStartAt) {
  const result = await db.query(
    `UPDATE user_carts
     SET order_status = 'deleted', order_status_synced_at = NOW()
     WHERE last_synced_at < $1
       AND order_status = 'pending'
     RETURNING id`,
    [syncStartAt]
  );
  if (result.rows.length) {
    const ids = result.rows.map((r) => r.id);
    const histStatuses = ids.map(() => "__order__deleted");
    await db.query(
      `INSERT INTO user_cart_comments (cart_id, text, created_by, created_at, status)
       SELECT unnest($1::int[]), '', 'system', NOW(), unnest($2::varchar[])`,
      [ids, histStatuses]
    );
  }
  return result.rows.length;
}

async function getCartsForOrderSync() {
  const r = await db.query(`
    SELECT id, invoice_id, customer_phone
    FROM user_carts
    WHERE invoice_id IS NOT NULL
      AND customer_phone IS NOT NULL
      AND (
        order_status IN ('pending', 'in_progress')
        OR (order_status IN ('delivered', 'cancelled') AND order_code IS NULL)
      )
  `);
  return r.rows;
}

async function bulkUpdateOrderStatus(updates) {
  if (!updates.length) return;
  const ids = updates.map((u) => u.id);
  const statuses = updates.map((u) => u.orderStatus);
  const codes = updates.map((u) => u.orderCode ?? null);

  // Update order status; collect which rows actually changed
  const updated = await db.query(
    `UPDATE user_carts
     SET order_status = u.status,
         order_code = CASE WHEN u.code IS NOT NULL THEN u.code ELSE user_carts.order_code END,
         order_status_synced_at = NOW()
     FROM (
       SELECT unnest($1::int[]) AS id, unnest($2::varchar[]) AS status, unnest($3::varchar[]) AS code
     ) u
     WHERE user_carts.id = u.id
       AND (
         user_carts.order_status NOT IN ('delivered', 'cancelled', 'deleted')
         OR u.code IS NOT NULL
       )
     RETURNING user_carts.id, u.status AS new_status`,
    [ids, statuses, codes]
  );

  // Write one history entry per changed cart
  if (updated.rows.length) {
    const histIds = updated.rows.map((r) => r.id);
    const histStatuses = updated.rows.map((r) => `__order__${r.new_status}`);
    await db.query(
      `INSERT INTO user_cart_comments (cart_id, text, created_by, created_at, status)
       SELECT unnest($1::int[]), '', 'system', NOW(), unnest($2::varchar[])`,
      [histIds, histStatuses]
    );
  }
}

async function claimCustomer(customerPhone, username) {
  // Check if someone else currently has an active claim
  const existing = await db.query(
    `SELECT claimed_by FROM customer_claims
     WHERE customer_phone = $1 AND claimed_at > NOW() - INTERVAL '15 minutes'`,
    [customerPhone]
  );
  const previousClaimer = existing.rows.length > 0 && existing.rows[0].claimed_by !== username
    ? existing.rows[0].claimed_by
    : null;

  await db.query(
    `INSERT INTO customer_claims (customer_phone, claimed_by, claimed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (customer_phone) DO UPDATE
       SET claimed_by = $2, claimed_at = NOW()`,
    [customerPhone, username]
  );
  return previousClaimer;
}

async function releaseCustomer(customerPhone, username) {
  await db.query(
    `DELETE FROM customer_claims
     WHERE customer_phone = $1 AND claimed_by = $2`,
    [customerPhone, username]
  );
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
  markMissingCartsDeleted,
  getCartsForOrderSync,
  bulkUpdateOrderStatus,
  claimCustomer,
  releaseCustomer,
};
