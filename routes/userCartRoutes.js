const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/userCartController");

router.get("/data", ctrl.getData);
router.get("/stats", ctrl.getStats);
router.get("/sync-status", ctrl.getSyncStatus);
router.post("/sync", ctrl.triggerSync);
router.put("/:id/comment", ctrl.updateComment);
router.get("/:id/comments", ctrl.getComments);
router.post("/:id/comments", ctrl.addComment);
router.get("/statuses", ctrl.getStatuses);
router.post("/statuses", ctrl.createStatus);
router.get("/filter-options", ctrl.getFilterOptions);

module.exports = router;
