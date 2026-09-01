import {
  decodeAddress,
  decodeUint256,
  ethGetLogs,
  hexToNumber,
} from "./rpc.js";

export const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4aa673f5b0ae4a2741fd";

export function decodeTransferLog(log) {
  return {
    blockNumber: hexToNumber(log.blockNumber),
    logIndex: hexToNumber(log.logIndex),
    from: decodeAddress(log.topics?.[1]),
    to: decodeAddress(log.topics?.[2]),
    value: decodeUint256(log.data),
    txHash: log.transactionHash ?? null,
  };
}

export function sortTransfers(transfers) {
  return [...transfers].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) return left.blockNumber - right.blockNumber;
    return left.logIndex - right.logIndex;
  });
}

export function balancesFromEntries(entries = []) {
  const balances = new Map();
  for (const entry of entries) {
    const account = String(entry.account ?? entry.address).toLowerCase();
    const balance = BigInt(entry.balance ?? entry.value ?? 0);
    if (balance > 0n) balances.set(account, balance);
  }
  return balances;
}

export function balancesToEntries(balances) {
  return [...balances.entries()]
    .filter(([, balance]) => balance > 0n)
    .map(([account, balance]) => ({ account, balance: balance.toString() }))
    .sort((left, right) => left.account.localeCompare(right.account));
}

/**
 * Apply ERC-20 Transfer deltas up to and including snapshotBlock.
 * Mutates the provided balances map.
 */
export function applyTransfers(balances, transfers, snapshotBlock) {
  for (const transfer of sortTransfers(transfers)) {
    if (transfer.blockNumber > snapshotBlock) break;
    if (transfer.value === 0n) continue;

    if (!isZeroAddress(transfer.from)) {
      const account = transfer.from.toLowerCase();
      const next = (balances.get(account) ?? 0n) - transfer.value;
      if (next < 0n) throw new Error(`negative_balance:${account}`);
      if (next === 0n) balances.delete(account);
      else balances.set(account, next);
    }

    if (!isZeroAddress(transfer.to)) {
      const account = transfer.to.toLowerCase();
      const next = (balances.get(account) ?? 0n) + transfer.value;
      if (next === 0n) balances.delete(account);
      else balances.set(account, next);
    }
  }
}

export async function fetchTransferLogs({
  rpcUrl,
  token,
  fromBlock,
  toBlock,
  fetchImpl = fetch,
  chunkSize = 5000,
}) {
  const tokenAddress = token.toLowerCase();
  const start = Number(fromBlock);
  const end = Number(toBlock);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new Error("invalid_block_range");
  }

  const logs = [];
  for (let block = start; block <= end; block += chunkSize) {
    const chunkEnd = Math.min(block + chunkSize - 1, end);
    const chunk = await ethGetLogs(
      rpcUrl,
      {
        address: tokenAddress,
        fromBlock: `0x${block.toString(16)}`,
        toBlock: `0x${chunkEnd.toString(16)}`,
        topics: [TRANSFER_EVENT_TOPIC],
      },
      fetchImpl,
    );
    logs.push(...chunk);
  }
  return logs;
}

/**
 * One-shot holder snapshot: fetch Transfer logs in [fromBlock, snapshotBlock],
 * optionally starting from a prior checkpoint balance set, then discard working state.
 */
export async function snapshotBalancesAtBlock({
  rpcUrl,
  token,
  snapshotBlock,
  fromBlock = 0,
  startingBalances = null,
  fetchImpl = fetch,
  chunkSize = 5000,
}) {
  if (!Number.isInteger(snapshotBlock) || snapshotBlock < 0) {
    throw new Error("invalid_snapshot_block");
  }

  const logs = await fetchTransferLogs({
    rpcUrl,
    token,
    fromBlock,
    toBlock: snapshotBlock,
    fetchImpl,
    chunkSize,
  });

  const balances = startingBalances instanceof Map
    ? new Map(startingBalances)
    : balancesFromEntries(startingBalances ?? []);

  applyTransfers(
    balances,
    logs.map(decodeTransferLog),
    snapshotBlock,
  );

  const lastLog = sortTransfers(logs.map(decodeTransferLog)).at(-1) ?? null;

  return {
    token: token.toLowerCase(),
    snapshotBlock,
    fromBlock,
    transferCount: logs.length,
    holderCount: balances.size,
    lastLog,
    balances: balancesToEntries(balances),
  };
}

function isZeroAddress(address) {
  return /^0x0{40}$/i.test(address);
}
