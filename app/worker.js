import { pathToFileURL } from "node:url";
import { platformConfig } from "./config.js";
import { createTransferIndexer } from "./indexer.js";
import { buildCommunitySnapshot } from "./manifest.js";
import { createManifestStore } from "./storage.js";

const HOUR_MS = 60 * 60 * 1000;
const config = platformConfig();
const interval = config.workerPollIntervalMs;

const indexer = createTransferIndexer();
const manifests = createManifestStore({
  directory: process.env.MANIFEST_DIR || null,
});

export async function runWorkerTick({
  now = Date.now(),
  logger = console,
  memberTokens = [],
  snapshotBlock = null,
  allocationPerCommunity = null,
} = {}) {
  const status = {
    service: "paymedividends-worker",
    phase: "indexing",
    executionMode: config.executionMode,
    databaseConfigured: config.databaseConfigured,
    hub: config.universalRewardsHub,
    memberTokenCount: memberTokens.length,
    cadence: "hourly",
    feeCollection: "skipped_until_execution_enabled",
    roundPublication: "idle",
    at: new Date(now).toISOString(),
  };

  if (config.executionMode !== "disabled") {
    throw new Error("execution_mode_unsafe");
  }

  status.message =
    "Hourly snapshot pipeline is active in dry-run mode. Transactions remain disabled until EXECUTION_MODE is audited.";

  if (memberTokens.length > 0 && snapshotBlock != null && allocationPerCommunity != null) {
    const published = [];
    for (const memberToken of memberTokens) {
      const balances = await indexer.getBalances(memberToken, snapshotBlock);
      if (balances.length === 0) continue;
      const snapshot = buildCommunitySnapshot({
        memberToken,
        snapshotBlock,
        allocationPerCommunity,
        balances,
      });
      await manifests.put(snapshot.manifestURI, snapshot.manifestBody);
      published.push({
        memberToken: memberToken.toLowerCase(),
        root: snapshot.root,
        manifestHash: snapshot.manifestHash,
        manifestURI: snapshot.manifestURI,
        holderCount: snapshot.manifest.holderCount,
      });
    }
    status.roundPublication = published.length === 0 ? "no_balances" : "manifests_ready";
    status.published = published;
    status.message =
      "Community manifests were built and stored content-addressably. Community projectAdmin signatures and onchain submit remain manual until the keeper is enabled.";
  } else if (!config.universalRewardsHub) {
    status.phase = "setup";
    status.message = "Waiting for UNIVERSAL_REWARDS_HUB before live holder indexing.";
  }

  logger.info(JSON.stringify(status));
  return status;
}

export function getWorkerDeps() {
  return { indexer, manifests, config, interval, hourMs: HOUR_MS };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWorkerTick();
  setInterval(() => {
    runWorkerTick().catch((error) => {
      console.error(JSON.stringify({ service: "paymedividends-worker", error: String(error) }));
    });
  }, interval);
}
