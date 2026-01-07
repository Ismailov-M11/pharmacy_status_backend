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

async function getNewPharmaciesReport(req, res) {
  try {
    const { from, to, compareFrom, compareTo } = req.query;

    // Helper to count pharmacies in a period
    const getPeriodData = async (startDate, endDate) => {
      if (!startDate || !endDate) return { items: [], count: 0 };
      const items = await pharmacy.getPharmaciesByDateRange(startDate, endDate);
      return { items, count: items.length };
    };

    const currentPeriod = await getPeriodData(from, to);
    const previousPeriod = await getPeriodData(compareFrom, compareTo);

    const diffValue = currentPeriod.count - previousPeriod.count;
    const diffPercent = previousPeriod.count > 0
      ? (diffValue / previousPeriod.count) * 100
      : 0;

    res.json({
      periodA: {
        label: `Current Period`,
        count: currentPeriod.count
      },
      periodB: {
        label: `Previous Period`,
        count: previousPeriod.count
      },
      diff: {
        value: diffValue,
        percent: diffPercent
      },
      items: currentPeriod.items
    });
  } catch (error) {
    console.error("Error in getNewPharmaciesReport:", error);
    res.status(500).json({ error: "Failed to fetch report" });
  }
}

async function getActivityReport(req, res) {
  try {
    const { from, to } = req.query;
    const events = await history.getHistoryByDateRange(from, to);

    const formattedEvents = events.map(event => ({
      id: event.id,
      changeDatetime: event.changed_at,
      code: event.code || 'N/A', // Assuming code comes from joined pharmacy_status
      pharmacyName: event.pharmacy_name || 'Unknown',
      address: event.address,
      district: event.district,
      phone: event.phone,
      responsiblePhone: event.responsible_phone,
      type: event.new_value ? 'ACTIVATED' : 'DEACTIVATED', // Assuming boolean maps to this
      source: event.changed_by.includes('system') ? 'system' : 'manual', // Simple heuristic
      currentStatus: event.new_value ? 'active' : 'inactive'
    }));

    const summary = {
      activated: formattedEvents.filter(e => e.type === 'ACTIVATED').length,
      deactivated: formattedEvents.filter(e => e.type === 'DEACTIVATED').length
    };

    res.json({
      summary,
      events: formattedEvents
    });
  } catch (error) {
    console.error("Error in getActivityReport:", error);
    res.status(500).json({ error: "Failed to fetch activity report" });
  }
}

module.exports = {
  getStatus,
  updateStatus,
  getStatusHistory,
  deleteStatus,
  getNewPharmaciesReport,
  getActivityReport
};
