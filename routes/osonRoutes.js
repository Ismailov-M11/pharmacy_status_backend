const express = require("express");
const router = express.Router();
const osonController = require("../controllers/osonController");

// GET /api/oson/data?status=&parentRegion=&region=&search=
router.get("/data", osonController.getData);

// POST /api/oson/sync  (Authorization: Bearer <davoToken>)
router.post("/sync", osonController.triggerSync);

// GET /api/oson/sync-status
router.get("/sync-status", osonController.getSyncStatus);

// GET /api/oson/filter-options?parentRegion=
router.get("/filter-options", osonController.getFilterOptions);

module.exports = router;
