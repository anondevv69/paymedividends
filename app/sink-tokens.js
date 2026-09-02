import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDopplerPool } from "./doppler.js";
import { listEnrollmentRequests } from "./enrollment.js";
import { MEME_ASSET_POLICY, listFactoryRouters, readRouterState } from "./router.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_SEEDS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../config/sink-route-seeds.json",
);

function isAddress(value) {
  return /^0x[a-f0-9]{40}$/.test(String(value ?? "").toLowerCase());
}

function routeKey(meme, paired) {
  return `${meme.toLowerCase()}:${paired.toLowerCase()}`;
}

function mergeRoute(byKey, route) {
  if (!isAddress(route.meme) || !isAddress(route.pairedAsset)) return;
  const key = routeKey(route.meme, route.pairedAsset);
  const existing = byKey.get(key);
  byKey.set(key, {
    ...existing,
    ...route,
    meme: route.meme.toLowerCase(),
    pairedAsset: route.pairedAsset.toLowerCase(),
    router: route.router?.toLowerCase() ?? existing?.router ?? null,
  });
}

export async function loadSeedRoutes({
  seedsPath = process.env.ROUTE_BUILDER_SEEDS_PATH ?? DEFAULT_SEEDS_PATH,
} = {}) {
  try {
    const body = await readFile(seedsPath, "utf8");
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function fetchRemoteEnrollmentRequests({
  apiUrl = process.env.PAYMEDIVIDENDS_API_URL ?? "https://paymedividends-production.up.railway.app",
  fetchImpl = fetch,
} = {}) {
  const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/v1/enrollment-requests`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload?.requests) ? payload.requests : [];
}

export async function discoverSinkTokens({
  rpcUrl,
  factory,
  manifestDir = null,
  fetchImpl = fetch,
  includeQuoteOnly = false,
  includeSeeds = true,
  includeRemoteEnrollment = true,
  seedRoutes = [],
} = {}) {
  if (!factory) throw new Error("project_router_factory_required");

  const routers = await listFactoryRouters(rpcUrl, factory, fetchImpl);
  const enrollment = manifestDir
    ? await listEnrollmentRequests(manifestDir, { limit: 500 })
    : (includeRemoteEnrollment ? await fetchRemoteEnrollmentRequests({ fetchImpl }) : []);
  const byKey = new Map();

  for (const router of routers) {
    const state = await readRouterState(rpcUrl, router, fetchImpl);
    if (!state.poolBound) continue;
    if (!includeQuoteOnly && state.memeAssetPolicy !== MEME_ASSET_POLICY.SwapToSettlement) continue;

    const meme = state.memeAsset !== ZERO_ADDRESS ? state.memeAsset : state.communityToken;
    const paired = state.pairedAsset;
    if (!isAddress(meme) || !isAddress(paired) || meme === ZERO_ADDRESS || paired === ZERO_ADDRESS) continue;

    mergeRoute(byKey, {
      meme,
      pairedAsset: paired,
      router: state.router,
      poolId: state.dopplerPoolId,
      memeAssetPolicy: state.memeAssetPolicy,
      memeBalance: state.memeBalance,
      source: "factory_router",
    });
  }

  for (const request of enrollment) {
    const meme = String(request.tokenAddress ?? "").toLowerCase();
    if (!isAddress(meme)) continue;

    const existing = [...byKey.values()].find((item) => item.meme === meme);
    if (existing) {
      existing.enrollmentStatus = request.status ?? "pending_governance";
      existing.enrollmentRouter = request.router?.toLowerCase() ?? existing.router;
      continue;
    }

    let pairedAsset = request.pairedStockAddress?.toLowerCase?.() ?? null;
    let poolId = request.poolId ?? null;
    if (!pairedAsset) {
      try {
        const pool = await fetchDopplerPool(meme, fetchImpl);
        pairedAsset = pool?.quoteToken?.address?.toLowerCase() ?? null;
        poolId = poolId ?? pool?.address ?? null;
      } catch {
        // enrollment row still useful without Doppler enrichment
      }
    }

    if (!pairedAsset) continue;
    mergeRoute(byKey, {
      meme,
      pairedAsset,
      router: request.router?.toLowerCase() ?? null,
      poolId,
      memeAssetPolicy: null,
      memeBalance: "0",
      source: "enrollment_queue",
      enrollmentStatus: request.status ?? "pending_governance",
      pairedStockSymbol: request.pairedStockSymbol ?? null,
      tokenSymbol: request.tokenSymbol ?? null,
    });
  }

  if (includeSeeds) {
    const seeds = seedRoutes.length > 0 ? seedRoutes : await loadSeedRoutes();
    for (const seed of seeds) mergeRoute(byKey, seed);
  }

  return [...byKey.values()].sort((left, right) => left.meme.localeCompare(right.meme));
}
