import { ethCall } from "./rpc.js";
import { fetchRobinscanHolders } from "./robinscan.js";

const DEFAULT_DECIMALS = 18;

export function parseQualifiedBalanceInput(value, decimals = DEFAULT_DECIMALS) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error("invalid_min_qualified_balance");
  return BigInt(raw) * 10n ** BigInt(decimals);
}

export async function fetchTokenDecimals(tokenAddress, rpcUrl, fetchImpl = fetch) {
  try {
    const result = await ethCall(rpcUrl, tokenAddress, "0x313ce567", fetchImpl);
    const decimals = Number.parseInt(result, 16);
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36
      ? decimals
      : DEFAULT_DECIMALS;
  } catch {
    return DEFAULT_DECIMALS;
  }
}

export function analyzeHolderBalances(holders, {
  minQualifiedBalance = 0n,
  minQualifiedHolders = 100,
  minTotalHolders = 100,
} = {}) {
  const sorted = [...holders].sort((left, right) => (left.balance > right.balance ? -1 : 1));
  const totalHolders = sorted.length;
  const qualifiedHolders = sorted.filter((row) => row.balance >= minQualifiedBalance).length;

  const gates = {
    minTotalHolders: {
      required: minTotalHolders,
      actual: totalHolders,
      passed: totalHolders >= minTotalHolders,
    },
    minQualifiedHolders: {
      required: minQualifiedHolders,
      actual: qualifiedHolders,
      passed: qualifiedHolders >= minQualifiedHolders,
    },
    minQualifiedBalance: minQualifiedBalance.toString(),
  };

  return {
    totalHolders,
    qualifiedHolders,
    minQualifiedBalance: minQualifiedBalance.toString(),
    gates,
    passed: gates.minTotalHolders.passed && gates.minQualifiedHolders.passed,
    topHolders: sorted.slice(0, 5).map((row) => ({
      account: row.account,
      balance: row.balance.toString(),
    })),
  };
}

export async function buildHolderStats({
  tokenAddress,
  rpcUrl,
  fetchImpl = fetch,
  minQualifiedBalance,
  minQualifiedHolders = 100,
  minTotalHolders = 100,
  source = "robinscan",
}) {
  if (!/^0x[a-f0-9]{40}$/.test(String(tokenAddress).toLowerCase())) {
    throw new Error("invalid_token_address");
  }

  const normalized = tokenAddress.toLowerCase();
  const decimals = await fetchTokenDecimals(normalized, rpcUrl, fetchImpl);
  const threshold = minQualifiedBalance == null
    ? 10_000_000n * 10n ** BigInt(decimals)
    : typeof minQualifiedBalance === "bigint"
      ? minQualifiedBalance
      : parseQualifiedBalanceInput(minQualifiedBalance, decimals);

  const { totalCount, holders } = await fetchRobinscanHolders(normalized, fetchImpl);
  const analysis = analyzeHolderBalances(holders, {
    minQualifiedBalance: threshold,
    minQualifiedHolders,
    minTotalHolders,
  });

  return {
    tokenAddress: normalized,
    decimals,
    source,
    indexedTotalCount: totalCount,
    minQualifiedBalanceHuman: Number(threshold) / 10 ** decimals,
    minQualifiedBalanceRaw: threshold.toString(),
    ...analysis,
    checkedAt: new Date().toISOString(),
    note:
      "Screening from Robinscan holder index. Payout rounds still use onchain Transfer snapshots at snapshotBlock.",
  };
}

export function enrollmentGateDefaults(config) {
  return {
    minTotalHolders: config.enrollmentMinTotalHolders,
    minQualifiedHolders: config.enrollmentMinQualifiedHolders,
    minQualifiedBalance: config.enrollmentMinQualifiedBalance,
  };
}
