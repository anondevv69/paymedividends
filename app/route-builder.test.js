import assert from "node:assert/strict";
import test from "node:test";
import { buildRegisterRouteTransaction, encodeRegisterMemeRouteSimple } from "./safe-batch.js";
import { buildRouteRegistrationBatch } from "./route-builder.js";
import { discoverSinkTokens } from "./sink-tokens.js";
import { MEME_ASSET_POLICY } from "./router.js";

test("encodeRegisterMemeRouteSimple matches ABI encoding", () => {
  const encoded = encodeRegisterMemeRouteSimple({
    meme: "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3",
    pairedAsset: "0xe93237c50d904957cf27e7b1133b510c669c2e74",
    active: true,
  });
  assert.match(encoded, /^0x114c55b6/);
});

test("buildRegisterRouteTransaction includes Safe metadata", () => {
  const tx = buildRegisterRouteTransaction({
    executor: "0xc28619a3e810b984b1d885e27858d405244971e1",
    meme: "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3",
    pairedAsset: "0xe93237c50d904957cf27e7b1133b510c669c2e74",
    tokenSymbol: "DEVS",
    pairedStockSymbol: "MSFT",
  });
  assert.equal(tx.to, "0xc28619a3e810b984b1d885e27858d405244971e1");
  assert.equal(tx.contractMethod.name, "registerMemeRouteSimple");
  assert.equal(tx.contractInputsValues.meme, "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3");
});

test("discoverSinkTokens merges factory routers and enrollment queue", async () => {
  const factory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const router = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const meme = "0xcccccccccccccccccccccccccccccccccccccccc";
  const paired = "0xdddddddddddddddddddddddddddddddddddddddd";

  const fetchImpl = async (url, init) => {
    if (String(url).includes("prod.indexer.doppler.lol")) {
      return {
        ok: true,
        async json() {
          return {
            data: {
              pools: {
                items: [{
                  address: "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0",
                  quoteToken: { address: paired, symbol: "MSFT" },
                  baseToken: { address: meme, symbol: "NEW" },
                }],
              },
            },
          };
        },
      };
    }

    const body = JSON.parse(init.body);
    if (body.method === "eth_call" && body.params[0].to === factory) {
      if (body.params[0].data === "0x8e67e049") {
        return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: "0x0000000000000000000000000000000000000000000000000000000000000001" }; } };
      }
      if (body.params[0].data.startsWith("0x4e3fda2a")) {
        return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(24)}${router.slice(2)}` }; } };
      }
    }
    if (body.method === "eth_call" && body.params[0].to === router) {
      const selector = body.params[0].data.slice(0, 10);
      const responses = {
        "0xcc8567eb": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "0x6d10ade4": `0x${MEME_ASSET_POLICY.SwapToSettlement.toString(16).padStart(64, "0")}`,
        "0xb13c346f": `0x${"0".repeat(24)}${meme.slice(2)}`,
        "0x39191d7b": `0x${"0".repeat(24)}${paired.slice(2)}`,
        "0x1aa8685b": "0x" + "1".repeat(64),
        "0x29aa1617": `0x${"0".repeat(24)}${meme.slice(2)}`,
      };
      return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: responses[selector] ?? "0x0" }; } };
    }
    if (body.method === "eth_call" && body.params[0].to === meme) {
      return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: "0x0" }; } };
    }
    throw new Error(`unexpected fetch ${url} ${body.method}`);
  };

  const routes = await discoverSinkTokens({
    rpcUrl: "https://rpc.test",
    factory,
    manifestDir: null,
    includeRemoteEnrollment: false,
    includeSeeds: false,
    fetchImpl,
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].meme, meme);
  assert.equal(routes[0].pairedAsset, paired);
});

test("discoverSinkTokens includes seed routes when no onchain matches", async () => {
  const factory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "eth_call" && body.params[0].data === "0x8e67e049") {
      return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: "0x0" }; } };
    }
    throw new Error(`unexpected ${body.method}`);
  };

  const routes = await discoverSinkTokens({
    rpcUrl: "https://rpc.test",
    factory,
    manifestDir: null,
    includeRemoteEnrollment: false,
    fetchImpl,
    seedRoutes: [{
      meme: "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3",
      pairedAsset: "0xe93237c50d904957cf27e7b1133b510c669c2e74",
      tokenSymbol: "DEVS",
      pairedStockSymbol: "MSFT",
      source: "seed",
    }],
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].tokenSymbol, "DEVS");
});

test("buildRouteRegistrationBatch creates hub setup txs plus one register tx per route", async () => {
  const hub = "0x6844d0814e904722777a48ae2cf7c4b8f78a19e5";
  const meme = "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3";
  const paired = "0xe93237c50d904957cf27e7b1133b510c669c2e74";
  const poolId = "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0";

  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method !== "eth_call" || body.params[0].to !== hub) {
      throw new Error(`unexpected fetch ${body.method}`);
    }
    return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: "0x0" }; } };
  };

  const batch = await buildRouteRegistrationBatch({
    config: {
      memeSwapExecutor: "0xc28619a3e810b984b1d885e27858d405244971e1",
      governanceSafe: "0x34a6cd0ee9704090aa0aae3e2957a81bb75029e84",
      universalRewardsHub: hub,
      robinhoodRpcUrl: "https://rpc.test",
      zeroXApiKey: null,
    },
    routes: [{
      meme,
      pairedAsset: paired,
      router: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      poolId,
      source: "factory_router",
      tokenSymbol: "DEVS",
      pairedStockSymbol: "MSFT",
    }],
    fetchImpl,
  });

  assert.equal(batch.safeBatch.transactions.length, 4);
  assert.equal(batch.safeBatch.transactions[0].contractMethod.name, "setApprovedAsset");
  assert.equal(batch.safeBatch.transactions[1].contractMethod.name, "setApprovedFeeManager");
  assert.equal(batch.safeBatch.transactions[2].contractMethod.name, "setApprovedPoolBinding");
  assert.equal(batch.safeBatch.transactions[3].contractMethod.name, "registerMemeRouteSimple");
  assert.equal(batch.routes[0].hubPrerequisites.pairedAssetApproved, false);
  assert.equal(batch.routes[0].hubPrerequisites.feeManagerApproved, false);
  assert.equal(batch.routes[0].hubPrerequisites.poolBindingApproved, false);
  assert.equal(batch.routes.length, 1);
  assert.equal(batch.executor, "0xc28619a3e810b984b1d885e27858d405244971e1");
});
