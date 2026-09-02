import assert from "node:assert/strict";
import test from "node:test";
import { platformConfig } from "./config.js";
import { runKeeperTick } from "./keeper.js";
import { buildCollectCalldata, buildProcessMemeCalldata, MEME_ASSET_POLICY } from "./router.js";

test("platform config accepts keeper dry-run mode", () => {
  const config = platformConfig({
    EXECUTION_MODE: "keeper_dry_run",
    KEEPER_MIN_SETTLEMENT_OUT: "99",
    MEME_TO_SPY_ADAPTER: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(config.executionMode, "keeper_dry_run");
  assert.equal(config.keeperMinSettlementOut, 99n);
  assert.equal(config.memeToSettlementAdapter, "0x1111111111111111111111111111111111111111");
});

test("router calldata encodes minimum settlement out", () => {
  assert.equal(
    buildCollectCalldata(99n),
    "0x38df073f0000000000000000000000000000000000000000000000000000000000000063",
  );
  assert.equal(
    buildProcessMemeCalldata(1n),
    "0x56b279e10000000000000000000000000000000000000000000000000000000000000001",
  );
});

test("keeper dry-run scans swap routers without broadcasting", async () => {
  const factory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const router = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const meme = "0xcccccccccccccccccccccccccccccccccccccccc";
  const calls = [];

  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, to: body.params?.[0]?.to, data: body.params?.[0]?.data });
    if (body.method === "eth_call" && body.params[0].to === factory.toLowerCase()) {
      if (body.params[0].data === "0x8e67e049") {
        return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: "0x0000000000000000000000000000000000000000000000000000000000000001" }; } };
      }
      if (body.params[0].data.startsWith("0x4e3fda2a")) {
        return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(24)}${router.slice(2)}` }; } };
      }
    }
    if (body.method === "eth_call" && body.params[0].to === router) {
      const data = body.params[0].data;
      const responses = {
        "0xcc8567eb": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x6d10ade4": `0x${MEME_ASSET_POLICY.SwapToSettlement.toString(16).padStart(64, "0")}`,
        "0xb13c346f": `0x${"0".repeat(24)}${meme.slice(2)}`,
        "0x39191d7b": "0x" + "0".repeat(64),
        "0x1aa8685b": "0x" + "1".repeat(64),
        "0x29aa1617": "0x" + "2".repeat(64),
      };
      const selector = data.slice(0, 10);
      return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: responses[selector] ?? "0x0" }; } };
    }
    if (body.method === "eth_call" && body.params[0].to === meme) {
      return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: "0x0000000000000000000000000000000000000000000000000000000000000064" }; } };
    }
    throw new Error(`unexpected rpc ${body.method} ${body.params?.[0]?.to} ${body.params?.[0]?.data}`);
  };

  const config = platformConfig({
    EXECUTION_MODE: "keeper_dry_run",
    PROJECT_ROUTER_FACTORY: factory,
    UNIVERSAL_REWARDS_HUB: "0xdddddddddddddddddddddddddddddddddddddddd",
    KEEPER_MIN_SETTLEMENT_OUT: "10",
    MEME_TO_SPY_ADAPTER: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    MEME_SWAP_EXECUTOR: "0xc87498e933d624e40e791322191ab03c7335057e",
    SWAP_QUOTE_PROVIDER: "doppler",
  });

  const status = await runKeeperTick({
    config,
    fetchImpl,
    logger: { info() {} },
    prepareRuntimeSwapImpl: async () => ({
      swapTarget: "0x8876789976decbfcbbbe364623c63652db8c0904",
      swapData: "0x1234",
      minBuyAmount: "1",
      quoteSource: "doppler",
      calldata: "0xe47e6824",
    }),
  });

  assert.equal(status.phase, "dry_run");
  assert.equal(status.routersScanned, 1);
  assert.equal(status.actions.length, 2);
  assert.equal(status.actions[0].action, "collectAndRouteBankrDopplerFees");
  assert.equal(status.actions[1].action, "processMemeAsset");
  assert.equal(status.actions[1].runtimeSwap.quoteSource, "doppler");
  assert.equal(status.actions[1].prepareCalldata, "0xe47e6824");
});
