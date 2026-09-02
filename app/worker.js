import { pathToFileURL } from "node:url";
import { platformConfig } from "./config.js";
import { createCheckpointStore, snapshotWithCheckpoint } from "./checkpoint-store.js";
import { runKeeperTick } from "./keeper.js";
import { buildCommunitySnapshot } from "./manifest.js";
import { snapshotBalancesAtBlock } from "./snapshot.js";
import { createManifestStore } from "./storage.js";

const HOUR_MS = 60 * 60 * 1000;
const config = platformConfig();

const checkpointStore = createCheckpointStore({
  directory: config.manifestDir ?? null,
});
const manifests = createManifestStore({
  directory: process.env.MANIFEST_DIR || null,
});

export async function runWorkerTick({
  now = Date.now(),
  logger = console,
  memberTokens = [],
  snapshotBlock = null,
  allocationPerCommunity = null,
  fetchImpl = fetch,
  rpcUrl = config.robinhoodRpcUrl,
  checkpointStoreImpl = checkpointStore,
  snapshotImpl = snapshotWithCheckpoint,
} = {}) {
  const status = {
    service: "paymedividends-worker",
    phase: "indexing",
    executionMode: config.executionMode,
    databaseConfigured: config.databaseConfigured,
    snapshotMode: "on_demand",
    hub: config.universalRewardsHub,
    memberTokenCount: memberTokens.length,
    cadence: "hourly",
    feeCollection: config.executionMode === "disabled"
      ? "skipped_until_execution_enabled"
      : config.executionMode,
    roundPublication: "idle",
    at: new Date(now).toISOString(),
  };

  if (config.executionMode === "keeper_dry_run" || config.executionMode === "keeper_live") {
    status.keeper = await runKeeperTick({ config, logger, fetchImpl, now });
  } else if (config.executionMode !== "disabled") {
    throw new Error("execution_mode_unsafe");
  }

  status.message = config.executionMode === "disabled"
    ? "Hourly worker is in dry-run mode. Holder snapshots run on-demand at round time — no persistent transfer history."
    : "Hourly worker ran the meme-fee keeper before snapshot work.";

  if (memberTokens.length > 0 && snapshotBlock != null && allocationPerCommunity != null) {
    const published = [];
    for (const memberToken of memberTokens) {
      const snapshot = await snapshotImpl({
        rpcUrl,
        token: memberToken,
        snapshotBlock,
        checkpointStore: checkpointStoreImpl,
        snapshotBalancesAtBlock,
        fetchImpl,
      });

      if (snapshot.balances.length === 0) continue;

      const manifest = buildCommunitySnapshot({
        memberToken,
        snapshotBlock,
        allocationPerCommunity,
        balances: snapshot.balances,
      });
      await manifests.put(manifest.manifestURI, manifest.manifestBody);
      published.push({
        memberToken: memberToken.toLowerCase(),
        root: manifest.root,
        manifestHash: manifest.manifestHash,
        manifestURI: manifest.manifestURI,
        holderCount: manifest.manifest.holderCount,
        transferCount: snapshot.transferCount,
        checkpointUsed: snapshot.checkpointUsed ?? false,
      });
    }
    status.roundPublication = published.length === 0 ? "no_balances" : "manifests_ready";
    status.published = published;
    status.message =
      "Community manifests were built from on-demand Transfer snapshots and stored content-addressably. "
      + "Community projectAdmin signatures and onchain submit remain manual until the keeper is enabled.";
  } else if (!config.universalRewardsHub) {
    status.phase = "setup";
    status.message = "Waiting for UNIVERSAL_REWARDS_HUB before live holder snapshots.";
  }

  logger.info(JSON.stringify(status));
  return status;
}

export function getWorkerDeps() {
  return {
    checkpointStore,
    manifests,
    config,
    interval: config.workerPollIntervalMs,
    hourMs: HOUR_MS,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT ?? "", 10);
  if (Number.isInteger(port) && port > 0) {
    const { createServer } = await import("node:http");
    createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        service: "paymedividends-worker",
        executionMode: config.executionMode,
      }));
    }).listen(port, () => {
      console.log(JSON.stringify({ service: "paymedividends-worker", health: `listening:${port}` }));
    });
  }

  await runWorkerTick();
  setInterval(() => {
    runWorkerTick().catch((error) => {
      console.error(JSON.stringify({ service: "paymedividends-worker", error: String(error) }));
    });
  }, config.workerPollIntervalMs);
}
