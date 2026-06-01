const express = require("express");
const router = express.Router();
const c = require("../controllers/contractController");

router.get("/:tin/links", c.getContractLinks);
router.get("/:tin/pdf", c.downloadPdf);
router.get("/:tin", c.getContract);

module.exports = router;
