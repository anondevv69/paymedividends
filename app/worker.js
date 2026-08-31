import { platformConfig } from "./config.js";

const config = platformConfig();
const interval = Math.max(Number.parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? "60000", 10), 30_000);

function tick() {
  console.info(JSON.stringify({
    service: "paymedividends-worker",
    phase: "setup",
    executionMode: config.executionMode,
    message: "Payout execution is intentionally disabled until contracts, adapters, storage, and keeper controls are complete.",
    at: new Date().toISOString(),
  }));
}

tick();
setInterval(tick, interval);

