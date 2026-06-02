const express = require("express");
const router = express.Router();
const { getPharmacyBatchData } = require("../controllers/batchController");

router.post("/pharmacy-data", getPharmacyBatchData);

module.exports = router;
