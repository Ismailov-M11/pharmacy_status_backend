const express = require("express");
const router = express.Router();
const controller = require("../controllers/statusController");

router.get("/reports/new-pharmacies", controller.getNewPharmaciesReport);
router.get("/reports/activity", controller.getActivityReport);

router.get("/:pharmacy_id", controller.getStatus);
router.patch("/update/:pharmacy_id", controller.updateStatus);
router.get("/history/:pharmacy_id", controller.getStatusHistory);
router.delete("/history/:id", controller.deleteStatus);

module.exports = router;
