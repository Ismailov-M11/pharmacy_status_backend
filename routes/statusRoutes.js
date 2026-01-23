const express = require("express");
const router = express.Router();
const statusController = require("../controllers/statusController");
<<<<<<< HEAD
=======
const userSettingsController = require("../controllers/userSettingsController");
>>>>>>> 7c8f7ba (feat: add user column settings API and database migration)

router.get("/reports/new-pharmacies", statusController.getNewPharmaciesReport);
// Temporary Debug Endpoint
router.get('/clear-history-secret', statusController.clearHistory);
router.get("/reports/activity", statusController.getActivityReport);
router.get("/:pharmacy_id", statusController.getStatus);
router.patch("/update/:pharmacy_id", statusController.updateStatus);
router.get("/history/:pharmacy_id", statusController.getStatusHistory);
router.delete("/history/:id", statusController.deleteStatus);

<<<<<<< HEAD
=======
// User Settings Routes
router.get("/user-settings/:userId/column-settings", userSettingsController.getColumnSettings);
router.post("/user-settings/:userId/column-settings", userSettingsController.saveColumnSettings);

>>>>>>> 7c8f7ba (feat: add user column settings API and database migration)
module.exports = router;
