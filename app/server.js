import http from "node:http";
import { pathToFileURL } from "node:url";
import { platformConfig, portFrom, publicPortFrom } from "./config.js";

function json(response, status, body, { cacheControl = "no-store" } = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": cacheControl,
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(body));
}

const ROBINHOOD_RHJ_ASSETS = "https://api.robinhood.com/rhj/assets";
const ROBINHOOD_RHJ_PRICES = "https://api.robinhood.com/rhj/prices";

export async function fetchBankrPairedStocks(fetchImpl = fetch) {
  const assetsResponse = await fetchImpl(ROBINHOOD_RHJ_ASSETS, {
    headers: { accept: "application/json" },
  });
  if (!assetsResponse.ok) {
    throw new Error(`Robinhood assets returned ${assetsResponse.status}`);
  }

  let priceBySymbol = new Map();
  try {
    const pricesResponse = await fetchImpl(ROBINHOOD_RHJ_PRICES, {
      headers: { accept: "application/json" },
    });
    if (pricesResponse.ok) {
      const pricesData = await pricesResponse.json();
      for (const quote of pricesData.quotes ?? []) {
        priceBySymbol.set(quote.tokenSymbol, quote);
      }
    }
  } catch {
    priceBySymbol = new Map();
  }

  const assetsData = await assetsResponse.json();
  const items = [];

  for (const asset of assetsData.assets ?? []) {
    if (asset.status !== "ASSET_STATUS_ACTIVE") continue;

    const deployment = (asset.deployments ?? []).find((entry) => entry.chainId === 4663);
    if (!deployment?.contractAddress) continue;

    const tradable = asset.tradingCapabilities?.market?.whole;
    if (tradable && tradable !== "TRADING_STATUS_TRADABLE") continue;

    const quote = priceBySymbol.get(asset.tokenSymbol);
    if (priceBySymbol.size > 0) {
      const bid = Number(quote?.bid ?? 0);
      const ask = Number(quote?.ask ?? 0);
      if (!(bid > 0) || !(ask > 0)) continue;
    }

    items.push({
      symbol: asset.tokenSymbol,
      name: String(asset.tokenName).replace(/ • Robinhood Token$/i, ""),
      address: deployment.contractAddress,
      isOfficialStock: true,
      priceUsd: quote?.bid && quote?.ask ? (Number(quote.bid) + Number(quote.ask)) / 2 : null,
    });
  }

  items.sort((left, right) => left.symbol.localeCompare(right.symbol));

  return {
    items,
    total: items.length,
    source: "robinhood-rhj",
    registry: ROBINHOOD_RHJ_ASSETS,
    note: "Robinhood official stock registry — the same chain-4663 addresses Bankr accepts as pairedStockAddress.",
  };
}

/** @deprecated Use fetchBankrPairedStocks */
export const fetchRobinhoodStocks = fetchBankrPairedStocks;

function serveBankrPairedStocks(response, fetchImpl) {
  fetchBankrPairedStocks(fetchImpl)
    .then((payload) => {
      json(response, 200, payload, { cacheControl: "public, max-age=300" });
    })
    .catch((error) => {
      json(response, 502, {
        error: "bankr_paired_stocks_unavailable",
        message: error?.message ?? "Could not load Bankr-compatible paired stocks.",
      });
    });
}

export function createServer({
  env = process.env,
  now = () => new Date().toISOString(),
  fetchImpl = fetch,
} = {}) {
  return http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      });
      response.end();
      return;
    }

    if (request.method !== "GET") {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }

    const { pathname } = new URL(request.url, "http://localhost");
    const config = platformConfig(env);

    if (pathname === "/" || pathname === "/health") {
      json(response, 200, {
        status: "ok",
        service: "paymedividends-api",
        phase: "setup",
        executionMode: config.executionMode,
        at: now(),
      });
      return;
    }

    if (pathname === "/v1/platform") {
      const factory = config.projectRouterFactory;
      const hub = config.universalRewardsHub;
      const deployed = Boolean(factory && hub);
      json(response, 200, {
        phase: deployed ? "contracts_live" : "setup",
        livePayoutsEnabled: false,
        platformFeeBps: config.platformFeeBps,
        targetChain: config.chain,
        chainId: 4663,
        rpcUrl: env.ROBINHOOD_MAINNET_RPC_URL ?? env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
        projectRouterFactory: factory,
        universalRewardsHub: hub,
        storage: {
          databaseConfigured: config.databaseConfigured,
          queueConfigured: config.queueConfigured,
          manifestDirConfigured: Boolean(config.manifestDir),
        },
        cadence: {
          mode: "hourly",
          workerPollIntervalMs: config.workerPollIntervalMs,
        },
        safety: "No private keys, launch-provider credentials, or live keeper execution are configured on the API.",
      });
      return;
    }

    if (pathname === "/v1/universal") {
      const deployed = config.universalRewardsHub !== null;
      json(response, 200, {
        phase: deployed ? "awaiting_indexer" : "not_deployed",
        universalRewardsHub: config.universalRewardsHub,
        projectRouterFactory: config.projectRouterFactory,
        verifiedContributorCount: 0,
        contributors: [],
        verification: deployed
          ? "Create a Project Router, point Bankr fees to it, then wait for Safe enrollment. Verified members appear here after indexing."
          : "No UniversalRewardsHub is configured on the API yet.",
      });
      return;
    }

    if (pathname === "/v1/bankr/paired-stocks" || pathname === "/v1/robinhood/stocks") {
      serveBankrPairedStocks(response, fetchImpl);
      return;
    }

    json(response, 404, { error: "not_found" });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ports = new Set([portFrom(), publicPortFrom()]);
  for (const port of ports) {
    const server = createServer();
    server.listen(port, "0.0.0.0", () => {
      console.info(`paymedividends API listening on ${port}`);
    });
  }
}
