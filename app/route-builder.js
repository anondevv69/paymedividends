import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { platformConfig } from "./config.js";
import { buildHubSetupTransactions } from "./hub-setup.js";
import { buildRegisterRouteTransaction, buildSafeBatch } from "./safe-batch.js";
import { discoverSinkTokens } from "./sink-tokens.js";
import { fetchZeroExSwapQuote, quoteToRuntimeSwap } from "./swap-quote.js";

export async function buildRouteRegistrationBatch({
  config,
  routes,
  executor = config.memeSwapExecutor,
  fetchImpl = fetch,
  includeQuotes = false,
  quoteAmount = 1_000_000_000_000_000_000n,
}) {
  if (!executor) throw new Error("meme_swap_executor_required");
  if (!config.universalRewardsHub) throw new Error("universal_rewards_hub_required");

  const transactions = [];
  const details = [];

  for (const route of routes) {
    const hubSetup = await buildHubSetupTransactions({
      rpcUrl: config.robinhoodRpcUrl,
      hub: config.universalRewardsHub,
      route,
      fetchImpl,
    });
    transactions.push(...hubSetup.transactions);

    const tx = buildRegisterRouteTransaction({
      executor,
      meme: route.meme,
      pairedAsset: route.pairedAsset,
      active: true,
      tokenSymbol: route.tokenSymbol,
      pairedStockSymbol: route.pairedStockSymbol,
    });
    transactions.push(tx);

    const detail = {
      meme: route.meme,
      pairedAsset: route.pairedAsset,
      router: route.router,
      poolId: route.poolId,
      source: route.source,
      hubPrerequisites: hubSetup.prerequisites,
      hubSetupTransactions: hubSetup.transactions,
      registrationTx: tx,
    };

    if (includeQuotes && config.zeroXApiKey) {
      try {
        const quote = await fetchZeroExSwapQuote({
          sellToken: route.meme,
          buyToken: route.pairedAsset,
          sellAmount: quoteAmount,
          taker: executor,
          apiKey: config.zeroXApiKey,
          fetchImpl,
        });
        detail.sampleQuote = quoteToRuntimeSwap(quote);
      } catch (error) {
        detail.sampleQuoteError = error?.message ?? "quote_failed";
      }
    }

    details.push(detail);
  }

  return {
    safeBatch: buildSafeBatch({
      name: "Register sink meme routes",
      description: "Approves Hub prerequisites, then registers meme → paired RWA routes on RobinhoodMemeSwapExecutor.",
      transactions,
    }),
    routes: details,
    executor,
    governanceSafe: config.governanceSafe,
  };
}

export async function writeRouteBuilderArtifacts({
  outputDir = "artifacts/route-builder",
  batch,
}) {
  await mkdir(outputDir, { recursive: true });
  const safePath = path.join(outputDir, "safe-batch.json");
  const routesPath = path.join(outputDir, "routes.json");
  await writeFile(safePath, `${JSON.stringify(batch.safeBatch, null, 2)}\n`, "utf8");
  await writeFile(routesPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    executor: batch.executor,
    governanceSafe: batch.governanceSafe,
    routes: batch.routes,
  }, null, 2)}\n`, "utf8");
  return { safePath, routesPath };
}

export async function runRouteBuilder({
  config = platformConfig(),
  fetchImpl = fetch,
  outputDir = process.env.ROUTE_BUILDER_OUTPUT_DIR ?? "artifacts/route-builder",
  includeQuotes = process.env.ROUTE_BUILDER_INCLUDE_QUOTES === "1",
} = {}) {
  const routes = await discoverSinkTokens({
    rpcUrl: config.robinhoodRpcUrl,
    factory: config.projectRouterFactory,
    manifestDir: config.manifestDir,
    fetchImpl,
    includeQuoteOnly: process.env.ROUTE_BUILDER_INCLUDE_QUOTE_ONLY === "1",
  });

  const batch = await buildRouteRegistrationBatch({
    config,
    routes,
    fetchImpl,
    includeQuotes,
  });

  const paths = await writeRouteBuilderArtifacts({ outputDir, batch });
  return {
    routeCount: routes.length,
    outputDir,
    ...paths,
    governanceSafe: batch.governanceSafe,
    executor: batch.executor,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runRouteBuilder({ config: platformConfig() });
  console.log(JSON.stringify(result, null, 2));
}
