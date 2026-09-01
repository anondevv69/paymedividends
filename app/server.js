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

const ROBINSCAN_STOCKS_API = "https://robinscan.io/api/stocks";

export async function fetchRobinhoodStocks(fetchImpl = fetch) {
  const stocks = [];
  let page = 1;
  let total = 0;

  while (page <= 20) {
    const response = await fetchImpl(`${ROBINSCAN_STOCKS_API}?page=${page}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Robinscan returned ${response.status}`);
    }

    const data = await response.json();
    const items = data.items ?? [];
    total = data.total ?? total;
    stocks.push(...items);
    if (!items.length || stocks.length >= total) break;
    page += 1;
  }

  stocks.sort((left, right) => {
    if (left.isOfficialStock !== right.isOfficialStock) {
      return Number(right.isOfficialStock) - Number(left.isOfficialStock);
    }
    return String(left.symbol).localeCompare(String(right.symbol));
  });

  return { items: stocks, total: total || stocks.length, source: "robinscan" };
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

    if (pathname === "/v1/robinhood/stocks") {
      fetchRobinhoodStocks(fetchImpl)
        .then((payload) => {
          json(response, 200, payload, { cacheControl: "public, max-age=300" });
        })
        .catch((error) => {
          json(response, 502, {
            error: "robinscan_unavailable",
            message: error?.message ?? "Could not load Robinhood stocks.",
          });
        });
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
