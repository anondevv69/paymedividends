import http from "node:http";
import { pathToFileURL } from "node:url";
import { platformConfig, portFrom, publicPortFrom } from "./config.js";
import {
  appendEnrollmentRequest,
  attachHolderQualification,
  attachSkippedHolderQualification,
  listEnrollmentRequests,
  validateEnrollmentRequest,
} from "./enrollment.js";
import { buildDirectoryIndex, formatDirectoryResponse } from "./directory.js";
import { buildHolderStats, enrollmentGateDefaults } from "./holder-stats.js";

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

const BANKR_BENEFICIARY_FEES = "https://api.bankr.bot/public/doppler/beneficiary-fees";

function parseSharePercent(share) {
  const match = String(share ?? "").match(/([\d.]+)/);
  return match ? Number.parseFloat(match[1]) : 0;
}

function pairedStockLabel(token) {
  const labels = [token.token0Label, token.token1Label].filter(Boolean);
  const meme = String(token.symbol ?? "").toUpperCase();
  for (const label of labels) {
    const upper = String(label).toUpperCase();
    if (upper !== "WETH" && upper !== "ETH" && upper !== meme) return upper;
  }
  return null;
}

export async function fetchBankrBeneficiaryFees(walletAddress, fetchImpl = fetch) {
  const normalized = walletAddress.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    throw new Error("wallet_address_required");
  }

  const response = await fetchImpl(`${BANKR_BENEFICIARY_FEES}/${normalized}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Bankr beneficiary fees returned ${response.status}`);
  }

  const data = await response.json();
  const eligible = (data.tokens ?? [])
    .filter((token) => token.chain === "robinhood")
    .filter((token) => parseSharePercent(token.share) >= 95)
    .map((token) => ({
      tokenAddress: token.tokenAddress,
      name: token.name,
      symbol: token.symbol,
      chain: token.chain,
      poolId: token.poolId,
      share: token.share,
      pairedStockSymbol: pairedStockLabel(token),
      token0Label: token.token0Label,
      token1Label: token.token1Label,
      claimable: token.claimable,
      source: token.source,
    }))
    .filter((token) => token.pairedStockSymbol);

  return {
    walletAddress: normalized,
    totalLaunches: data.totalLaunches ?? eligible.length,
    eligibleCount: eligible.length,
    items: eligible,
    source: "bankr-beneficiary-fees",
    note: "Robinhood Chain tokens where this wallet is ≥95% fee beneficiary and paired with an RWA/stock quote.",
  };
}

function serveBankrBeneficiaryFees(response, walletAddress, fetchImpl) {
  fetchBankrBeneficiaryFees(walletAddress, fetchImpl)
    .then((payload) => {
      json(response, 200, payload, { cacheControl: "public, max-age=60" });
    })
    .catch((error) => {
      json(response, 502, {
        error: "bankr_beneficiary_fees_unavailable",
        message: error?.message ?? "Could not load Bankr beneficiary positions.",
      });
    });
}

async function readJsonBody(request, { maxBytes = 65536 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  return JSON.parse(body);
}

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

function serveUniversalDirectory(response, config, fetchImpl, requestUrl) {
  const factory = config.projectRouterFactory;
  const hub = config.universalRewardsHub;
  const rpcUrl = config.robinhoodRpcUrl;

  if (!factory || !hub) {
    json(response, 200, {
      phase: "not_deployed",
      universalRewardsHub: hub,
      projectRouterFactory: factory,
      verifiedContributorCount: 0,
      contributors: [],
      items: [],
      leaderboard: [],
      verification: "No UniversalRewardsHub is configured on the API yet.",
    });
    return;
  }

  const forceRefresh = requestUrl.searchParams.get("refresh") === "1";

  buildDirectoryIndex({
    rpcUrl,
    factory,
    hub,
    manifestDir: config.manifestDir,
    fetchImpl,
    forceRefresh,
  })
    .then((snapshot) => {
      json(response, 200, formatDirectoryResponse(snapshot), {
        cacheControl: forceRefresh ? "no-store" : "public, max-age=60",
      });
    })
    .catch((error) => {
      json(response, 502, {
        phase: "directory_unavailable",
        universalRewardsHub: hub,
        projectRouterFactory: factory,
        verifiedContributorCount: 0,
        contributors: [],
        items: [],
        leaderboard: [],
        error: "directory_index_failed",
        message: error?.message ?? "Could not build the member directory.",
      });
    });
}

export function createServer({
  env = process.env,
  now = () => new Date().toISOString(),
  fetchImpl = fetch,
} = {}) {
  return http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      response.end();
      return;
    }

    const { pathname } = new URL(request.url, "http://localhost");
    const config = platformConfig(env);

    if (request.method === "POST" && pathname === "/v1/enrollment-requests") {
      if (!config.manifestDir) {
        json(response, 503, {
          error: "enrollment_queue_unavailable",
          message: "Enrollment queue is not configured on this API (MANIFEST_DIR missing).",
        });
        return;
      }

      try {
        const body = await readJsonBody(request);
        const gateDefaults = enrollmentGateDefaults(config);
        const fields = validateEnrollmentRequest(body, gateDefaults);
        let record = {
          ...fields,
          requestedBy: String(body?.requestedBy ?? fields.feeBeneficiary).toLowerCase(),
          requestedAt: now(),
          id: `${fields.tokenAddress}-${Date.now()}`,
        };

        if (fields.skipHolderChecks) {
          record = attachSkippedHolderQualification(record);
        } else {
          const holderStats = await buildHolderStats({
            tokenAddress: fields.tokenAddress,
            rpcUrl: config.robinhoodRpcUrl,
            fetchImpl,
            minQualifiedBalance: fields.minQualifiedBalance,
            minQualifiedHolders: fields.minQualifiedHolders,
            minTotalHolders: fields.minTotalHolders,
          });
          record = attachHolderQualification(record, holderStats);
        }

        await appendEnrollmentRequest(config.manifestDir, record);
        json(response, 201, {
          status: "queued",
          id: record.id,
          holderQualification: record.holderQualification,
          message: record.holderQualification.passed
            ? "Enrollment request queued for governance Safe review."
            : "Enrollment request queued with holder gate failure — governance should reject or request more distribution.",
        });
      } catch (error) {
        if (error instanceof SyntaxError) {
          json(response, 400, { error: "invalid_json" });
          return;
        }
        const message = error?.message ?? "invalid_request";
        if (message === "holder_stats_unavailable") {
          json(response, 502, { error: message, message: "Could not load holder screening data." });
          return;
        }
        const status = message.startsWith("invalid_") ? 400 : 500;
        json(response, status, { error: message });
      }
      return;
    }

    if (request.method !== "GET") {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }

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
        rpcUrl: config.robinhoodRpcUrl,
        projectRouterFactory: factory,
        universalRewardsHub: hub,
        memeToSettlementAdapter: config.memeToSettlementAdapter,
        memeSwapExecutor: config.memeSwapExecutor,
        memeAssetPolicy: config.memeToSettlementAdapter ? "SwapToSettlement" : "QuoteOnly",
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

    if (pathname === "/v1/universal" || pathname === "/v1/directory") {
      serveUniversalDirectory(response, config, fetchImpl, new URL(request.url, "http://localhost"));
      return;
    }

    if (pathname === "/v1/bankr/paired-stocks" || pathname === "/v1/robinhood/stocks") {
      serveBankrPairedStocks(response, fetchImpl);
      return;
    }

    const beneficiaryMatch = pathname.match(/^\/v1\/bankr\/beneficiary-fees\/(0x[a-fA-F0-9]{40})$/);
    if (beneficiaryMatch) {
      serveBankrBeneficiaryFees(response, beneficiaryMatch[1], fetchImpl);
      return;
    }

    const holderStatsMatch = pathname.match(/^\/v1\/tokens\/(0x[a-fA-F0-9]{40})\/holder-stats$/);
    if (holderStatsMatch) {
      const requestUrl = new URL(request.url, "http://localhost");
      const gateDefaults = enrollmentGateDefaults(config);
      buildHolderStats({
        tokenAddress: holderStatsMatch[1],
        rpcUrl: config.robinhoodRpcUrl,
        fetchImpl,
        minQualifiedBalance: requestUrl.searchParams.get("minQualifiedBalance")
          ?? String(gateDefaults.minQualifiedBalance),
        minQualifiedHolders: Number(
          requestUrl.searchParams.get("minQualifiedHolders") ?? gateDefaults.minQualifiedHolders,
        ),
        minTotalHolders: Number(
          requestUrl.searchParams.get("minTotalHolders") ?? gateDefaults.minTotalHolders,
        ),
      })
        .then((payload) => {
          json(response, 200, payload, { cacheControl: "public, max-age=60" });
        })
        .catch((error) => {
          const message = error?.message ?? "holder_stats_failed";
          const status = message.startsWith("invalid_") ? 400 : 502;
          json(response, status, { error: message });
        });
      return;
    }

    if (pathname === "/v1/enrollment-requests") {
      listEnrollmentRequests(config.manifestDir)
        .then((items) => {
          json(response, 200, {
            total: items.length,
            items,
            note: "Pending governance review. Safe calls enrollMemberRouter after verification.",
          });
        })
        .catch((error) => {
          json(response, 500, { error: "enrollment_list_failed", message: error?.message });
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
