const db = require("../db");

async function addHistory(pharmacy_id, field, old_value, new_value, comment, changed_by) {
  await db.query(
    `INSERT INTO status_history 
    (pharmacy_id, field, old_value, new_value, comment, changed_by)
    VALUES ($1, $2, $3, $4, $5, $6)`,
    [pharmacy_id, field, old_value, new_value, comment, changed_by]
  );
}

async function getHistory(pharmacy_id) {
  const result = await db.query(
    "SELECT * FROM status_history WHERE pharmacy_id = $1 ORDER BY changed_at DESC",
    [pharmacy_id]
  );
  return result.rows;
}

async function deleteHistory(id) {
  await db.query("DELETE FROM status_history WHERE id = $1", [id]);
}

async function getHistoryByDateRange(fromDate, toDate) {
  const query = `
    SELECT 
      sh.*
    FROM status_history sh
    LEFT JOIN pharmacy_status ps ON sh.pharmacy_id = ps.pharmacy_id
    WHERE sh.changed_at >= $1 AND sh.changed_at <= $2
    ORDER BY sh.changed_at DESC
  `;

  const result = await db.query(query, [fromDate, toDate]);
  return result.rows;
}

module.exports = {
  addHistory,
  getHistory,
  deleteHistory,
  getHistoryByDateRange
};
