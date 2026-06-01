const cron = require("node-cron");
const didox = require("./didoxService");
const contractModel = require("../models/contractModel");

async function refreshContracts(tins) {
  for (const tin of tins) {
    // Check before each individual request — stop the whole loop if blocked
    const blockedMs = await didox.getBlockedMs();
    if (blockedMs > 0) {
      const minutes = Math.ceil(blockedMs / 60_000);
      console.warn(`Didox polling: rate-limited, stopping batch. Resume in ~${minutes} min.`);
      return;
    }

    const fresh = await didox.getContractStatusByTin(tin);
    await contractModel.upsertContract(tin, fresh);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function refreshAllKnown() {
  const blockedMs = await didox.getBlockedMs();
  if (blockedMs > 0) {
    const minutes = Math.ceil(blockedMs / 60_000);
    console.warn(`Didox polling: skipping run, rate-limited for ~${minutes} more min.`);
    return;
  }

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
