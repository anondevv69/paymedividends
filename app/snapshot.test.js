import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryCheckpointStore, snapshotWithCheckpoint } from "./checkpoint-store.js";
import {
  applyTransfers,
  decodeTransferLog,
  snapshotBalancesAtBlock,
  sortTransfers,
} from "./snapshot.js";

test("applyTransfers reconstructs balances at a snapshot block", () => {
  const balances = new Map();
  applyTransfers(
    balances,
    sortTransfers([
      { blockNumber: 1, logIndex: 0, from: "0x0000000000000000000000000000000000000000", to: "0x1111111111111111111111111111111111111111", value: 100n },
      { blockNumber: 2, logIndex: 0, from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", value: 40n },
      { blockNumber: 3, logIndex: 0, from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", value: 10n },
    ]),
    2,
  );

  assert.deepEqual(
    [...balances.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [
      ["0x1111111111111111111111111111111111111111", 60n],
      ["0x2222222222222222222222222222222222222222", 40n],
    ],
  );
});

test("decodeTransferLog parses indexed ERC-20 Transfer logs", () => {
  const transfer = decodeTransferLog({
    blockNumber: "0x2",
    logIndex: "0x1",
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4aa673f5b0ae4a2741fd",
      "0x0000000000000000000000001111111111111111111111111111111111111111",
      "0x0000000000000000000000002222222222222222222222222222222222222222",
    ],
    data: "0x0000000000000000000000000000000000000000000000000000000000000064",
    transactionHash: "0xabc",
  });

  assert.equal(transfer.blockNumber, 2);
  assert.equal(transfer.logIndex, 1);
  assert.equal(transfer.value, 100n);
  assert.equal(transfer.from, "0x1111111111111111111111111111111111111111");
});

test("snapshotBalancesAtBlock fetches logs once and returns holder balances", async () => {
  const token = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const calls = [];

  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return {
      ok: true,
      async json() {
        if (body.method === "eth_getLogs") {
          return {
            jsonrpc: "2.0",
            id: 1,
            result: [{
              blockNumber: "0xa",
              logIndex: "0x0",
              topics: [
                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4aa673f5b0ae4a2741fd",
                "0x0000000000000000000000000000000000000000000000000000000000000000",
                "0x0000000000000000000000001111111111111111111111111111111111111111",
              ],
              data: "0x0000000000000000000000000000000000000000000000000000000000000064",
              transactionHash: "0x1",
            }],
          };
        }
        throw new Error(`unexpected rpc method ${body.method}`);
      },
    };
  };

  const snapshot = await snapshotBalancesAtBlock({
    rpcUrl: "https://rpc.test",
    token,
    snapshotBlock: 10,
    fetchImpl,
  });

  assert.equal(snapshot.transferCount, 1);
  assert.equal(snapshot.holderCount, 1);
  assert.equal(snapshot.balances[0].account, "0x1111111111111111111111111111111111111111");
  assert.equal(snapshot.balances[0].balance, "100");
  assert.equal(calls.length, 1);
});

test("snapshotWithCheckpoint reuses prior balances for later blocks", async () => {
  const token = "0xcccccccccccccccccccccccccccccccccccccccc";
  const store = createMemoryCheckpointStore();

  await store.put(token, {
    snapshotBlock: 5,
    balances: [{ account: "0x1111111111111111111111111111111111111111", balance: "100" }],
    lastLog: { blockNumber: 5, logIndex: 0 },
  });

  const snapshot = await snapshotWithCheckpoint({
    rpcUrl: "https://rpc.test",
    token,
    snapshotBlock: 10,
    checkpointStore: store,
    snapshotBalancesAtBlock: async ({ startingBalances, snapshotBlock }) => ({
      token,
      snapshotBlock,
      fromBlock: 6,
      transferCount: 1,
      holderCount: 2,
      lastLog: { blockNumber: 10, logIndex: 0 },
      balances: [
        ...(startingBalances ?? []),
        { account: "0x2222222222222222222222222222222222222222", balance: "50" },
      ],
    }),
  });

  assert.equal(snapshot.checkpointUsed, true);
  assert.equal(snapshot.balances.length, 2);
});
