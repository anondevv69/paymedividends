import assert from "node:assert/strict";
import test from "node:test";
import { createTransferIndexer } from "./indexer.js";
import { createMemoryCheckpointStore } from "./checkpoint-store.js";
import { buildCommunitySnapshot } from "./manifest.js";
import { buildMerkleTree, claimLeaf, getProof, verifyProof } from "./merkle.js";
import { createManifestStore } from "./storage.js";
import { getWorkerDeps, runWorkerTick } from "./worker.js";

test("merkle proofs verify against the sorted keccak tree", () => {
  const leaves = [
    claimLeaf(0, "0x1111111111111111111111111111111111111111", 10n),
    claimLeaf(1, "0x2222222222222222222222222222222222222222", 20n),
    claimLeaf(2, "0x3333333333333333333333333333333333333333", 30n),
  ];
  const tree = buildMerkleTree(leaves);
  for (let i = 0; i < leaves.length; i += 1) {
    assert.equal(verifyProof(getProof(tree, i), tree.root, leaves[i]), true);
  }
});

test("community snapshot builds a content-addressed pro-rata manifest", async () => {
  const snapshot = buildCommunitySnapshot({
    memberToken: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    snapshotBlock: 100,
    allocationPerCommunity: 1000n,
    balances: [
      { account: "0x1111111111111111111111111111111111111111", balance: 25n },
      { account: "0x2222222222222222222222222222222222222222", balance: 75n },
    ],
    generatedAt: "2026-08-31T00:00:00.000Z",
  });

  assert.match(snapshot.root, /^0x[a-f0-9]{64}$/);
  assert.match(snapshot.manifestHash, /^0x[a-f0-9]{64}$/);
  assert.equal(snapshot.manifestURI, `pmd://${snapshot.manifestHash.slice(2)}`);
  assert.equal(snapshot.manifest.claims[0].amount, "250");
  assert.equal(snapshot.manifest.claims[1].amount, "750");

  const store = createManifestStore();
  await store.put(snapshot.manifestURI, snapshot.manifestBody);
  assert.equal(await store.get(snapshot.manifestURI), snapshot.manifestBody);
});

test("transfer indexer reconstructs balances at a snapshot block", async () => {
  const indexer = createTransferIndexer();
  const token = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const alice = "0x1111111111111111111111111111111111111111";
  const bob = "0x2222222222222222222222222222222222222222";

  await indexer.applyTransfer({
    token,
    blockNumber: 1,
    logIndex: 0,
    from: "0x0000000000000000000000000000000000000000",
    to: alice,
    value: 100n,
  });
  await indexer.applyTransfer({
    token,
    blockNumber: 2,
    logIndex: 0,
    from: alice,
    to: bob,
    value: 40n,
  });
  await indexer.applyTransfer({
    token,
    blockNumber: 3,
    logIndex: 0,
    from: alice,
    to: bob,
    value: 10n,
  });

  const atBlock2 = await indexer.getBalances(token, 2);
  assert.deepEqual(
    atBlock2.sort((a, b) => a.account.localeCompare(b.account)),
    [
      { account: alice, balance: "60" },
      { account: bob, balance: "40" },
    ],
  );
});

test("worker dry-run publishes manifests from on-demand snapshots", async () => {
  const token = "0xcccccccccccccccccccccccccccccccccccccccc";
  const checkpointStoreImpl = createMemoryCheckpointStore();

  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method !== "eth_getLogs") throw new Error(`unexpected rpc method ${body.method}`);
    return {
      ok: true,
      async json() {
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
      },
    };
  };

  const logs = [];
  const status = await runWorkerTick({
    now: Date.now(),
    memberTokens: [token],
    snapshotBlock: 10,
    allocationPerCommunity: 95n,
    fetchImpl,
    rpcUrl: "https://rpc.test",
    checkpointStoreImpl,
    logger: { info: (line) => logs.push(line) },
  });

  assert.equal(status.executionMode, "disabled");
  assert.equal(status.snapshotMode, "on_demand");
  assert.equal(status.cadence, "hourly");
  assert.equal(status.roundPublication, "manifests_ready");
  assert.equal(status.published.length, 1);
  assert.equal(status.published[0].transferCount, 1);
  assert.equal(status.feeCollection, "skipped_until_execution_enabled");
  assert.equal(logs.length, 1);
});

test("getWorkerDeps exposes checkpoint store instead of persistent indexer", () => {
  const deps = getWorkerDeps();
  assert.ok(deps.checkpointStore);
  assert.ok(deps.manifests);
});
