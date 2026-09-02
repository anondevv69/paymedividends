import { pathToFileURL } from "node:url";
import { platformConfig } from "./config.js";
import { canPrepareRuntimeSwap, prepareRuntimeSwap } from "./swap-provider.js";
import { sendLegacyTransaction } from "./tx.js";
import {
  MEME_ASSET_POLICY,
  buildCollectCalldata,
  buildProcessMemeCalldata,
  listFactoryRouters,
  readRouterState,
} from "./router.js";

export { prepareRuntimeSwap } from "./swap-provider.js";

export async function runKeeperTick({
  config,
  logger = console,
  fetchImpl = fetch,
  sendTransaction = sendLegacyTransaction,
  prepareRuntimeSwapImpl = prepareRuntimeSwap,
  now = Date.now(),
} = {}) {
  const status = {
    service: "paymedividends-keeper",
    executionMode: config.executionMode,
    factory: config.projectRouterFactory,
    memeToSettlementAdapter: config.memeToSettlementAdapter,
    memeSwapExecutor: config.memeSwapExecutor,
    keeperMinSettlementOut: config.keeperMinSettlementOut.toString(),
    at: new Date(now).toISOString(),
    routersScanned: 0,
    actions: [],
    live: config.executionMode === "keeper_live",
  };

  if (!config.projectRouterFactory) {
    status.phase = "setup";
    status.message = "Waiting for PROJECT_ROUTER_FACTORY before keeper scans.";
    logger.info(JSON.stringify(status));
    return status;
  }

  if (config.executionMode !== "keeper_dry_run" && config.executionMode !== "keeper_live") {
    status.phase = "skipped";
    status.message = "Keeper is disabled for this execution mode.";
    logger.info(JSON.stringify(status));
    return status;
  }

  if (config.executionMode === "keeper_live" && !config.keeperPrivateKey) {
    throw new Error("keeper_private_key_required");
  }

  const routers = await listFactoryRouters(config.robinhoodRpcUrl, config.projectRouterFactory, fetchImpl);
  status.routersScanned = routers.length;

  for (const router of routers) {
    const routerState = await readRouterState(config.robinhoodRpcUrl, router, fetchImpl);
    if (!routerState.poolBound) {
      status.actions.push({ router, action: "skip", reason: "pool_not_bound" });
      continue;
    }

    if (routerState.memeAssetPolicy !== MEME_ASSET_POLICY.SwapToSettlement) {
      status.actions.push({
        router,
        action: "skip",
        reason: "quote_only_or_non_swap_policy",
        memeAssetPolicy: routerState.memeAssetPolicy,
      });
      continue;
    }

    const minOut = config.keeperMinSettlementOut;
    const collectCalldata = buildCollectCalldata(minOut);
    const collectAction = {
      router,
      action: "collectAndRouteBankrDopplerFees",
      minimumSettlementOut: minOut.toString(),
      memeAsset: routerState.memeAsset,
      memeBalance: routerState.memeBalance,
      calldata: collectCalldata,
    };

    if (config.executionMode === "keeper_live") {
      collectAction.txHash = await sendTransaction({
        rpcUrl: config.robinhoodRpcUrl,
        privateKey: config.keeperPrivateKey,
        to: router,
        data: collectCalldata,
        fetchImpl,
      });
    }
    status.actions.push(collectAction);

    const refreshed = config.executionMode === "keeper_live"
      ? await readRouterState(config.robinhoodRpcUrl, router, fetchImpl)
      : routerState;
    const memeBalance = BigInt(refreshed.memeBalance);
    if (memeBalance > 0n) {
      const processAction = {
        router,
        action: "processMemeAsset",
        minimumSettlementOut: minOut.toString(),
        memeBalance: refreshed.memeBalance,
        memeAsset: refreshed.memeAsset,
        pairedAsset: refreshed.pairedAsset,
      };

      if (canPrepareRuntimeSwap(config)) {
        try {
          const runtime = await prepareRuntimeSwapImpl({
            config,
            meme: refreshed.memeAsset,
            pairedAsset: refreshed.pairedAsset,
            sellAmount: memeBalance,
            fetchImpl,
          });
          processAction.runtimeSwap = {
            swapTarget: runtime.swapTarget,
            minBuyAmount: runtime.minBuyAmount,
            quoteSource: runtime.quoteSource ?? "unknown",
          };
          processAction.calldata = buildProcessMemeCalldata(minOut);
          processAction.prepareCalldata = runtime.calldata;

          if (config.executionMode === "keeper_live") {
            processAction.prepareTxHash = await sendTransaction({
              rpcUrl: config.robinhoodRpcUrl,
              privateKey: config.keeperPrivateKey,
              to: config.memeSwapExecutor,
              data: runtime.calldata,
              fetchImpl,
            });
            processAction.txHash = await sendTransaction({
              rpcUrl: config.robinhoodRpcUrl,
              privateKey: config.keeperPrivateKey,
              to: router,
              data: processAction.calldata,
              fetchImpl,
            });
          }
        } catch (error) {
          processAction.action = "processMemeAsset_skipped";
          processAction.reason = error?.message ?? "runtime_swap_failed";
        }
      } else {
        processAction.calldata = buildProcessMemeCalldata(minOut);
        processAction.note = "Configure MEME_SWAP_EXECUTOR and a swap quote provider (doppler or 0x).";
        if (config.executionMode === "keeper_live") {
          processAction.txHash = await sendTransaction({
            rpcUrl: config.robinhoodRpcUrl,
            privateKey: config.keeperPrivateKey,
            to: router,
            data: processAction.calldata,
            fetchImpl,
          });
        }
      }

      status.actions.push(processAction);
    }
  }

  status.phase = config.executionMode === "keeper_live" ? "executed" : "dry_run";
  status.message = config.executionMode === "keeper_live"
    ? "Keeper submitted collect/process transactions for SwapToSettlement routers."
    : "Keeper dry-run completed. No transactions were broadcast.";
  logger.info(JSON.stringify(status));
  return status;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runKeeperTick({ config: platformConfig() });
}
