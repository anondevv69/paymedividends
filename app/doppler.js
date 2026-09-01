const DOPPLER_GRAPHQL = "https://prod.indexer.doppler.lol/";
const ROBINHOOD_CHAIN_ID = 4663;

const TOKEN_QUERY = `
query Token($address: String!, $chainId: Float!) {
  token(address: $address, chainId: $chainId) {
    address symbol name chainId
  }
}`;

const POOL_QUERY = `
query Pool($baseToken: String!, $chainId: Float!) {
  pools(where: { baseToken: $baseToken, chainId: $chainId }, limit: 1) {
    items {
      address
      marketCapUsd
      holderCount
      volumeUsd
      lastSwapTimestamp
      beneficiaries
      quoteToken { address symbol name }
      baseToken { address symbol name }
    }
  }
}`;

const HOLDERS_QUERY = `
query Holders($assetId: String!, $chainId: Int!, $limit: Int!, $offset: Int!, $orderBy: String!, $orderDirection: String!) {
  userAssets(
    where: { assetId: $assetId, chainId: $chainId, balance_gt: "0" }
    limit: $limit
    offset: $offset
    orderBy: $orderBy
    orderDirection: $orderDirection
  ) {
    totalCount
    items { userId balance assetId }
  }
}`;

async function gql(query, variables, fetchImpl = fetch) {
  const response = await fetchImpl(DOPPLER_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message ?? "doppler_graphql_failed");
  }
  return payload.data;
}

export async function fetchDopplerToken(tokenAddress, fetchImpl = fetch) {
  const data = await gql(TOKEN_QUERY, {
    address: tokenAddress.toLowerCase(),
    chainId: ROBINHOOD_CHAIN_ID,
  }, fetchImpl);
  return data?.token ?? null;
}

export async function fetchDopplerPool(tokenAddress, fetchImpl = fetch) {
  const data = await gql(POOL_QUERY, {
    baseToken: tokenAddress.toLowerCase(),
    chainId: ROBINHOOD_CHAIN_ID,
  }, fetchImpl);
  return data?.pools?.items?.[0] ?? null;
}

export async function fetchDopplerHolderCount(tokenAddress, fetchImpl = fetch) {
  try {
    const data = await gql(HOLDERS_QUERY, {
      assetId: tokenAddress.toLowerCase(),
      chainId: ROBINHOOD_CHAIN_ID,
      limit: 1,
      offset: 0,
      orderBy: "balance",
      orderDirection: "desc",
    }, fetchImpl);
    return data?.userAssets?.totalCount ?? null;
  } catch {
    return null;
  }
}

export async function fetchDopplerHolders(tokenAddress, fetchImpl = fetch, { pageSize = 200, maxPages = 100 } = {}) {
  const assetId = tokenAddress.toLowerCase();
  const holders = [];
  let totalCount = null;
  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const data = await gql(HOLDERS_QUERY, {
      assetId,
      chainId: ROBINHOOD_CHAIN_ID,
      limit: pageSize,
      offset,
      orderBy: "balance",
      orderDirection: "desc",
    }, fetchImpl);
    const batch = data?.userAssets;
    if (totalCount == null) totalCount = batch?.totalCount ?? holders.length;
    const items = batch?.items ?? [];
    for (const item of items) {
      holders.push({
        account: String(item.userId).toLowerCase(),
        balance: BigInt(item.balance),
      });
    }
    if (items.length < pageSize) break;
    offset += pageSize;
  }

  return { totalCount: totalCount ?? holders.length, holders };
}

export function parseUsdFixed(raw) {
  if (raw == null || raw === "" || raw === "0") return null;
  try {
    const value = BigInt(String(raw));
    const whole = value / 10n ** 18n;
    const cents = (value % 10n ** 18n) / 10n ** 16n;
    return Number(whole) + Number(cents) / 100;
  } catch {
    return null;
  }
}

export function normalizeDopplerPool(pool) {
  if (!pool) return null;
  const beneficiaries = Array.isArray(pool.beneficiaries) ? pool.beneficiaries : [];
  const primary = beneficiaries.find((row) => BigInt(row.shares ?? 0) >= 950000000000000000n);
  return {
    poolId: pool.address?.toLowerCase() ?? null,
    marketCapUsd: parseUsdFixed(pool.marketCapUsd),
    holderCount: pool.holderCount ?? null,
    volumeUsd: parseUsdFixed(pool.volumeUsd),
    lastSwapTimestamp: pool.lastSwapTimestamp ? Number(pool.lastSwapTimestamp) : null,
    pairedStockSymbol: pool.quoteToken?.symbol ?? null,
    pairedStockName: pool.quoteToken?.name ?? null,
    pairedStockAddress: pool.quoteToken?.address?.toLowerCase() ?? null,
    tokenSymbol: pool.baseToken?.symbol ?? null,
    tokenName: pool.baseToken?.name ?? null,
    feeBeneficiary: primary?.beneficiary?.toLowerCase() ?? null,
    beneficiaries,
  };
}
