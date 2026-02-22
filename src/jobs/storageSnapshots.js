const { upsertStorageSnapshots } = require("../routes/dashboard");

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentTimeHHMM() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function startStorageSnapshotSchedule() {
  const enabled = process.env.STORAGE_SNAPSHOT_SCHEDULE_ENABLED !== "false";
  if (!enabled) {
    return;
  }

  const runAt = process.env.STORAGE_SNAPSHOT_SCHEDULE_HHMM || "00:10";
  let lastRunDate = null;

  const tick = async () => {
    const today = getTodayDate();
    const nowHHMM = getCurrentTimeHHMM();

    if (nowHHMM !== runAt || lastRunDate === today) {
      return;
    }

    try {
      await upsertStorageSnapshots(today, { warehouseId: null, clientId: null });
      lastRunDate = today;
      console.log(`[storage_snapshots] generated for ${today} at ${nowHHMM}`);
    } catch (error) {
      console.error(`[storage_snapshots] schedule failed for ${today}: ${error.message}`);
    }
  };

  setInterval(tick, 60 * 1000);
  console.log(`[storage_snapshots] daily schedule enabled at ${runAt}`);
}

module.exports = {
  startStorageSnapshotSchedule
};
