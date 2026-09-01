import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { listEnrollmentRequests } from "./enrollment.js";
import { fetchDopplerPool, fetchDopplerToken, normalizeDopplerPool } from "./doppler.js";
import { fetchRobinscanHolderCount } from "./robinscan.js";
import {
  decodeAddress,
  decodeBool,
  decodeBytes32,
  decodeUint256,
  encodeAddress,
  encodeCall,
  encodeUint256,
  ethCall,
  ethGetLogs,
  hexToNumber,
} from "./rpc.js";

const MIN_FEE_SHARE = 950000000000000000n;
const FEE_MANAGER = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544";
const GET_SHARES = "0x5ebb58fb";

const SELECTORS = {
  routerCount: "0x8e67e049",
  routerAt: "0x4e3fda2a",
  activeMemberCount: "0x5fb6c6ed",
  memberTokenAt: "0x3853922b",
  isActiveMemberToken: "0x4def65ee",
  routerForMemberToken: "0x0ab29808",
  scheduledRouterForMemberToken: "0xdef23dee",
  memberActivationTime: "0x5dac9401",
  communityToken: "0x29aa1617",
  pairedAsset: "0x39191d7b",
  poolBound: "0xcc8567eb",
  dopplerPoolId: "0x1aa8685b",
  projectAdmin: "0x036a9955",
};

const EVENTS = {
  memberRouterScheduled: "0xdc9f3927d86caf76ab5689ca5d67ab1849b06c748f53b7efc0c2d60a2f3795ee",
  memberRouterEnrolled: "0x26e130ab889e935c9f94b5cc1bcb412cd7489e8f0b53d402ed4e45b611eb364a",
  memberRouterDeactivated: "0x...", // optional
};

const CACHE_FILE = "directory-snapshot.json";
const CACHE_TTL_MS = 5 * 60 * 1000;

export function directoryCachePath(manifestDir) {
  if (!manifestDir) return null;
  return path.join(manifestDir, CACHE_FILE);
}

export async function readDirectoryCache(manifestDir) {
  const filePath = directoryCachePath(manifestDir);
  if (!filePath) return null;
  try {
    const body = await readFile(filePath, "utf8");
    return JSON.parse(body);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDirectoryCache(manifestDir, snapshot) {
  const filePath = directoryCachePath(manifestDir);
  if (!filePath) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot)}\n`, "utf8");
}

function isAddress(value) {
  return /^0x[a-f0-9]{40}$/.test(String(value ?? "").toLowerCase());
}

function normalizePoolId(poolId) {
  if (!poolId) return null;
  const hex = String(poolId).replace(/^0x/, "").toLowerCase();
  if (hex.length !== 64) return poolId.toLowerCase();
  return `0x${hex}`;
}

export function deriveStatus({
  poolBound,
  feesVerified,
  enrollmentStatus,
  hubActive,
  hubScheduled,
  hubActivatesAt,
}) {
  if (hubActive) return "enrolled";
  if (hubScheduled) return hubActivatesAt ? "activation_pending" : "scheduled";
  if (enrollmentStatus === "pending_governance") return "enrollment_pending";
  if (feesVerified) return "fees_verified";
  if (poolBound) return "pool_bound";
  return "router_created";
}

export function buildLeaderboard(items) {
  return [...items]
    .filter((item) => item.marketCapUsd != null && item.marketCapUsd > 0)
    .sort((left, right) => right.marketCapUsd - left.marketCapUsd)
    .slice(0, 20)
    .map((item) => ({
      tokenAddress: item.tokenAddress,
      symbol: item.symbol,
      pairedStockSymbol: item.pairedStockSymbol,
      marketCapUsd: item.marketCapUsd,
      holderCount: item.holderCount,
      status: item.status,
    }));
}

async function callRouter(rpcUrl, router, selector, arg = null, fetchImpl) {
  let data = selector;
  if (arg != null) {
    data = encodeCall(selector, encodeAddress(arg));
  }
  return ethCall(rpcUrl, router, data, fetchImpl);
}

async function readRouterState(rpcUrl, router, fetchImpl) {
  const [projectAdminRaw, communityTokenRaw, pairedAssetRaw, poolBoundRaw, poolIdRaw] = await Promise.all([
    ethCall(rpcUrl, router, SELECTORS.projectAdmin, fetchImpl),
    ethCall(rpcUrl, router, SELECTORS.communityToken, fetchImpl),
    ethCall(rpcUrl, router, SELECTORS.pairedAsset, fetchImpl),
    ethCall(rpcUrl, router, SELECTORS.poolBound, fetchImpl),
    ethCall(rpcUrl, router, SELECTORS.dopplerPoolId, fetchImpl),
  ]);

  const communityToken = decodeAddress(communityTokenRaw);
  const pairedAsset = decodeAddress(pairedAssetRaw);
  return {
    router: router.toLowerCase(),
    projectAdmin: decodeAddress(projectAdminRaw),
    communityToken: /^0x0{40}$/.test(communityToken) ? null : communityToken,
    pairedAsset: /^0x0{40}$/.test(pairedAsset) ? null : pairedAsset,
    poolBound: decodeBool(poolBoundRaw),
    poolId: decodeBytes32(poolIdRaw),
  };
}

function isZeroPoolId(poolId) {
  if (!poolId) return true;
  const hex = String(poolId).replace(/^0x/, "").toLowerCase();
  return !hex || /^0+$/.test(hex);
}

async function readFeeShare(rpcUrl, poolId, beneficiary, fetchImpl) {
  if (!poolId || !beneficiary || isZeroPoolId(poolId)) return 0n;
  try {
    const data = `${GET_SHARES}${padPoolId(poolId)}${encodeAddress(beneficiary).slice(2)}`;
    const raw = await ethCall(rpcUrl, FEE_MANAGER, data, fetchImpl);
    return decodeUint256(raw);
  } catch {
    return 0n;
  }
}

function padPoolId(poolId) {
  return poolId.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

async function listFactoryRouters(rpcUrl, factory, fetchImpl) {
  const countHex = await ethCall(rpcUrl, factory, SELECTORS.routerCount, fetchImpl);
  const count = hexToNumber(countHex);
  const routers = [];
  for (let index = 0; index < count; index += 1) {
    const data = encodeCall(SELECTORS.routerAt, encodeUint256(index));
    const raw = await ethCall(rpcUrl, factory, data, fetchImpl);
    routers.push(decodeAddress(raw));
  }
  return routers;
}

async function listActiveMemberTokens(rpcUrl, hub, fetchImpl) {
  const countHex = await ethCall(rpcUrl, hub, SELECTORS.activeMemberCount, fetchImpl);
  const count = hexToNumber(countHex);
  const tokens = [];
  for (let index = 0; index < count; index += 1) {
    const data = encodeCall(SELECTORS.memberTokenAt, encodeUint256(index));
    const raw = await ethCall(rpcUrl, hub, data, fetchImpl);
    tokens.push(decodeAddress(raw));
  }
  return tokens;
}

async function readHubMemberState(rpcUrl, hub, memberToken, fetchImpl) {
  const [activeRaw, routerRaw, scheduledRaw, activationRaw] = await Promise.all([
    ethCall(rpcUrl, hub, encodeCall(SELECTORS.isActiveMemberToken, encodeAddress(memberToken)), fetchImpl),
    ethCall(rpcUrl, hub, encodeCall(SELECTORS.routerForMemberToken, encodeAddress(memberToken)), fetchImpl),
    ethCall(rpcUrl, hub, encodeCall(SELECTORS.scheduledRouterForMemberToken, encodeAddress(memberToken)), fetchImpl),
    ethCall(rpcUrl, hub, encodeCall(SELECTORS.memberActivationTime, encodeAddress(memberToken)), fetchImpl),
  ]);

  const scheduledRouter = decodeAddress(scheduledRaw);
  const enrolledRouter = decodeAddress(routerRaw);
  return {
    hubActive: decodeBool(activeRaw),
    hubRouter: /^0x0{40}$/.test(enrolledRouter) ? null : enrolledRouter,
    hubScheduled: !/^0x0{40}$/.test(scheduledRouter),
    scheduledRouter: /^0x0{40}$/.test(scheduledRouter) ? null : scheduledRouter,
    hubActivatesAt: decodeUint256(activationRaw) > 0n
      ? new Date(Number(decodeUint256(activationRaw)) * 1000).toISOString()
      : null,
  };
}

async function fetchScheduledFromLogs(rpcUrl, hub, fetchImpl) {
  try {
    const logs = await ethGetLogs(rpcUrl, {
      address: hub,
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [EVENTS.memberRouterScheduled],
    }, fetchImpl);
    return logs.map((log) => ({
      router: decodeAddress(log.topics[1]),
      memberToken: decodeAddress(log.topics[2]),
      activatesAt: decodeUint256(log.data),
    }));
  } catch {
    return [];
  }
}

function enrollmentIndex(requests) {
  const byToken = new Map();
  const byRouter = new Map();
  for (const request of requests) {
    if (request.tokenAddress) byToken.set(request.tokenAddress.toLowerCase(), request);
    if (request.router) byRouter.set(request.router.toLowerCase(), request);
  }
  return { byToken, byRouter };
}

async function enrichTokenMetrics(tokenAddress, fetchImpl) {
  if (!isAddress(tokenAddress)) return {};
  try {
    const [pool, holderCount] = await Promise.all([
      fetchDopplerPool(tokenAddress, fetchImpl).catch(() => null),
      fetchRobinscanHolderCount(tokenAddress, fetchImpl).catch(() => null),
    ]);
    const normalized = normalizeDopplerPool(pool);
    if (!normalized) {
      const token = await fetchDopplerToken(tokenAddress, fetchImpl).catch(() => null);
      return {
        symbol: token?.symbol ?? null,
        name: token?.name ?? null,
        holderCount,
        holderCountSource: holderCount != null ? "robinscan" : null,
      };
    }
    return {
      symbol: normalized.tokenSymbol,
      name: normalized.tokenName,
      pairedStockSymbol: normalized.pairedStockSymbol,
      pairedStockAddress: normalized.pairedStockAddress,
      marketCapUsd: normalized.marketCapUsd,
      volumeUsd: normalized.volumeUsd,
      holderCount,
      holderCountSource: holderCount != null ? "robinscan" : null,
      poolId: normalized.poolId,
      feeBeneficiary: normalized.feeBeneficiary,
      lastSwapTimestamp: normalized.lastSwapTimestamp,
    };
  } catch {
    return {};
  }
}

export async function buildDirectoryIndex({
  rpcUrl,
  factory,
  hub,
  manifestDir = null,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  forceRefresh = false,
}) {
  if (!rpcUrl || !factory || !hub) {
    throw new Error("directory_config_incomplete");
  }

  if (!forceRefresh && manifestDir) {
    const cached = await readDirectoryCache(manifestDir);
    if (cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
      return cached;
    }
  }

  const [routers, activeTokens, enrollmentRequests, scheduledLogs] = await Promise.all([
    listFactoryRouters(rpcUrl, factory, fetchImpl),
    listActiveMemberTokens(rpcUrl, hub, fetchImpl),
    listEnrollmentRequests(manifestDir).catch(() => []),
    fetchScheduledFromLogs(rpcUrl, hub, fetchImpl),
  ]);

  const { byToken: enrollmentByToken, byRouter: enrollmentByRouter } = enrollmentIndex(enrollmentRequests);
  const itemsByKey = new Map();

  const upsert = (key, patch) => {
    const current = itemsByKey.get(key) ?? {};
    itemsByKey.set(key, { ...current, ...patch });
  };

  for (const router of routers) {
    const routerState = await readRouterState(rpcUrl, router, fetchImpl);
    const key = routerState.communityToken ?? router;
    upsert(key, {
      router,
      ...routerState,
      source: "factory",
    });
  }

  for (const memberToken of activeTokens) {
    const hubState = await readHubMemberState(rpcUrl, hub, memberToken, fetchImpl);
    upsert(memberToken, {
      tokenAddress: memberToken,
      ...hubState,
      source: "hub_active",
    });
  }

  for (const scheduled of scheduledLogs) {
    upsert(scheduled.memberToken, {
      tokenAddress: scheduled.memberToken,
      router: scheduled.router,
      scheduledRouter: scheduled.router,
      hubScheduled: true,
      hubActivatesAt: scheduled.activatesAt > 0n
        ? new Date(Number(scheduled.activatesAt) * 1000).toISOString()
        : null,
      source: "hub_scheduled",
    });
  }

  for (const request of enrollmentRequests) {
    const key = request.tokenAddress ?? request.router;
    if (!key) continue;
    upsert(key.toLowerCase(), {
      tokenAddress: request.tokenAddress,
      router: request.router,
      symbol: request.tokenSymbol ?? undefined,
      pairedStockSymbol: request.pairedStockSymbol ?? undefined,
      poolId: request.poolId ?? undefined,
      enrollmentStatus: request.status,
      enrollmentRequestedAt: request.requestedAt,
      source: "enrollment_queue",
    });
  }

  const items = [];
  for (const [key, base] of itemsByKey.entries()) {
    const tokenAddress = base.communityToken ?? base.tokenAddress ?? (isAddress(key) ? key : null);
    const router = base.router ?? base.hubRouter ?? base.scheduledRouter ?? null;
    const enrollment = tokenAddress
      ? enrollmentByToken.get(tokenAddress.toLowerCase())
      : router
        ? enrollmentByRouter.get(router.toLowerCase())
        : null;

    let hubState = {};
    if (tokenAddress && /^0x[a-f0-9]{40}$/.test(tokenAddress) && !/^0x0{40}$/.test(tokenAddress)) {
      try {
        hubState = await readHubMemberState(rpcUrl, hub, tokenAddress, fetchImpl);
      } catch {
        hubState = {};
      }
    }

    const metrics = tokenAddress
      ? await enrichTokenMetrics(tokenAddress, fetchImpl)
      : {};

    const poolId = normalizePoolId(base.poolId ?? metrics.poolId ?? enrollment?.poolId);
    const feeShare = poolId && router
      ? await readFeeShare(rpcUrl, poolId, router, fetchImpl)
      : 0n;

    const feesVerified = feeShare >= MIN_FEE_SHARE;
    const status = deriveStatus({
      poolBound: Boolean(base.poolBound),
      feesVerified,
      enrollmentStatus: enrollment?.status ?? base.enrollmentStatus,
      hubActive: hubState.hubActive ?? base.hubActive ?? false,
      hubScheduled: hubState.hubScheduled ?? base.hubScheduled ?? false,
      hubActivatesAt: hubState.hubActivatesAt ?? base.hubActivatesAt ?? null,
    });

    items.push({
      id: tokenAddress ?? router ?? key,
      tokenAddress,
      router: hubState.hubRouter ?? router,
      projectAdmin: base.projectAdmin ?? null,
      symbol: metrics.symbol ?? base.symbol ?? enrollment?.tokenSymbol ?? null,
      name: metrics.name ?? null,
      pairedStockSymbol: metrics.pairedStockSymbol ?? base.pairedStockSymbol ?? enrollment?.pairedStockSymbol ?? null,
      pairedStockAddress: metrics.pairedStockAddress ?? null,
      poolId,
      poolBound: Boolean(base.poolBound),
      feesVerified,
      feeShareBps: Number((feeShare * 10000n) / 10n ** 18n) / 100,
      status,
      hubActive: hubState.hubActive ?? false,
      hubScheduled: hubState.hubScheduled ?? false,
      hubActivatesAt: hubState.hubActivatesAt ?? null,
      enrollmentStatus: enrollment?.status ?? base.enrollmentStatus ?? null,
      enrollmentRequestedAt: enrollment?.requestedAt ?? base.enrollmentRequestedAt ?? null,
      marketCapUsd: metrics.marketCapUsd ?? null,
      volumeUsd: metrics.volumeUsd ?? null,
      holderCount: metrics.holderCount ?? null,
      holderCountSource: metrics.holderCountSource ?? null,
      lastSwapTimestamp: metrics.lastSwapTimestamp ?? null,
      feeBeneficiary: metrics.feeBeneficiary ?? null,
      explorerToken: tokenAddress
        ? `https://robinhoodchain.blockscout.com/address/${tokenAddress}`
        : null,
      explorerRouter: router
        ? `https://robinhoodchain.blockscout.com/address/${router}`
        : null,
    });
  }

  items.sort((left, right) => {
    const rank = statusRank(left.status) - statusRank(right.status);
    if (rank !== 0) return rank;
    return (right.marketCapUsd ?? 0) - (left.marketCapUsd ?? 0);
  });

  const snapshot = {
    fetchedAt: now(),
    chainId: 4663,
    factory: factory.toLowerCase(),
    hub: hub.toLowerCase(),
    sources: {
      onchain: "ProjectRouterFactory + UniversalRewardsHub",
      marketData: "https://prod.indexer.doppler.lol/",
      holderData: "https://robinscan.io/",
      enrollmentQueue: manifestDir ? "MANIFEST_DIR/enrollment-requests.jsonl" : null,
    },
    totals: {
      routers: routers.length,
      tokensTracked: items.filter((item) => item.tokenAddress).length,
      feesVerified: items.filter((item) => item.feesVerified).length,
      enrollmentPending: items.filter((item) => item.status === "enrollment_pending").length,
      hubScheduled: items.filter((item) => item.status === "activation_pending" || item.status === "scheduled").length,
      hubEnrolled: items.filter((item) => item.status === "enrolled").length,
    },
    leaderboard: buildLeaderboard(items),
    items,
  };

  if (manifestDir) {
    await writeDirectoryCache(manifestDir, snapshot);
  }

  return snapshot;
}

function statusRank(status) {
  switch (status) {
    case "enrolled": return 0;
    case "activation_pending":
    case "scheduled": return 1;
    case "enrollment_pending": return 2;
    case "fees_verified": return 3;
    case "pool_bound": return 4;
    default: return 5;
  }
}

export function formatDirectoryResponse(snapshot) {
  return {
    phase: "directory_live",
    universalRewardsHub: snapshot.hub,
    projectRouterFactory: snapshot.factory,
    verifiedContributorCount: snapshot.totals.hubEnrolled,
    fetchedAt: snapshot.fetchedAt,
    totals: snapshot.totals,
    leaderboard: snapshot.leaderboard,
    contributors: snapshot.items.map((item) => ({
      tokenAddress: item.tokenAddress,
      router: item.router,
      symbol: item.symbol,
      pairedStockSymbol: item.pairedStockSymbol,
      status: item.status,
      marketCapUsd: item.marketCapUsd,
      volumeUsd: item.volumeUsd,
      holderCount: item.holderCount,
      feesVerified: item.feesVerified,
      poolBound: item.poolBound,
      hubActive: item.hubActive,
      enrollmentStatus: item.enrollmentStatus,
    })),
    items: snapshot.items,
    verification:
      "Directory merges factory routers, Hub enrollment, Doppler market data, and the governance enrollment queue.",
  };
}
