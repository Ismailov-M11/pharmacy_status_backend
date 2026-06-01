const cron = require("node-cron");
const didox = require("./didoxService");
const contractModel = require("../models/contractModel");

async function refreshContracts(tins) {
  for (const tin of tins) {
    const fresh = await didox.getContractStatusByTin(tin);
    await contractModel.upsertContract(tin, fresh);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function refreshAllKnown() {
  const all = await contractModel.getAllContracts();
  const tins = all.map((r) => r.tin);
  if (tins.length) await refreshContracts(tins);
}

function startDidoxCron() {
  cron.schedule("*/5 * * * *", () => {
    refreshAllKnown().catch((e) => console.error("Didox cron error:", e.message));
  });
  console.log("Didox contract polling scheduled (every 5m)");
}

module.exports = { startDidoxCron, refreshContracts, refreshAllKnown };
