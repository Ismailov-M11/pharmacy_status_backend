const pharmacy = require("../models/pharmacyStatusModel");
const history = require("../models/statusHistoryModel");

async function getStatus(req, res) {
  const { pharmacy_id } = req.params;
  const data = await pharmacy.getOrCreatePharmacyStatus(pharmacy_id);
  res.json(data);
}

async function updateStatus(req, res) {
  const { pharmacy_id } = req.params;
  const { update_type, new_value, comment, changed_by } = req.body;

  if (!["training", "brandedPacket"].includes(update_type)) {
    return res.status(400).json({ error: "Invalid update type" });
  }

  const current = await pharmacy.getOrCreatePharmacyStatus(pharmacy_id);
  const old_value = current[update_type];

  await history.addHistory(
    pharmacy_id,
    update_type,
    old_value,
    new_value,
    comment,
    changed_by
  );

  const updated = await pharmacy.updatePharmacyStatus(pharmacy_id, update_type, new_value);

  res.json(updated);
}

async function getStatusHistory(req, res) {
  const { pharmacy_id } = req.params;
  const result = await history.getHistory(pharmacy_id);
  res.json(result);
}

async function deleteStatus(req, res) {
  const { id } = req.params;
  await history.deleteHistory(id);
  res.json({ success: true, deleted_id: id });
}

module.exports = {
  getStatus,
  updateStatus,
  getStatusHistory,
  deleteStatus
};
