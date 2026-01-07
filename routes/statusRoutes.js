const express = require("express");
const router = express.Router();
const statusController = require("../controllers/statusController");

router.get("/reports/new-pharmacies", statusController.getNewPharmaciesReport);
// Temporary Debug Endpoint
router.get('/clear-history-secret', statusController.clearHistory);
router.get("/reports/activity", statusController.getActivityReport);
router.get("/:pharmacy_id", statusController.getStatus);
router.patch("/update/:pharmacy_id", statusController.updateStatus);
router.get("/history/:pharmacy_id", statusController.getStatusHistory);
router.delete("/history/:id", statusController.deleteStatus);

module.exports = router;
