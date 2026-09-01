import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { publicPortFrom } from "./config.js";
import { createServer, fetchBankrPairedStocks, fetchBankrBeneficiaryFees } from "./server.js";

async function request(server, path, { method = "GET", body } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test("health endpoint reports a disabled setup service", async (t) => {
  const server = createServer({ env: { EXECUTION_MODE: "disabled" }, now: () => "2026-08-31T00:00:00.000Z" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await request(server, "/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.executionMode, "disabled");
  assert.equal(response.body.phase, "setup");
});

test("platform endpoint never reports live payouts before configuration", async (t) => {
  const server = createServer({ env: { EXECUTION_MODE: "disabled", PLATFORM_FEE_BPS: "500" } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await request(server, "/v1/platform");
  assert.equal(response.status, 200);
  assert.equal(response.body.platformFeeBps, 500);
  assert.equal(response.body.livePayoutsEnabled, false);
});

test("universal directory never invents contributor tokens before deployment", async (t) => {
  const server = createServer({ env: { EXECUTION_MODE: "disabled" } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await request(server, "/v1/universal");
  assert.equal(response.status, 200);
  assert.equal(response.body.phase, "not_deployed");
  assert.deepEqual(response.body.contributors, []);
  assert.equal(response.body.verifiedContributorCount, 0);
});

test("universal directory builds from onchain and doppler sources", async (t) => {
  const factory = "0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7";
  const hub = "0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5";
  const router = "0x00000000000000000000000000000000000000a1";
  const token = "0x0000000000000000000000000000000000000b1";

  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (String(url).includes("prod.indexer.doppler.lol")) {
      const query = body?.query ?? "";
      return {
        ok: true,
        async json() {
          if (query.includes("userAssets")) {
            return { data: { userAssets: { totalCount: 42 } } };
          }
          return {
            data: {
              pools: {
                items: [{
                  address: "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0",
                  marketCapUsd: "1000000000000000000",
                  holderCount: 42,
                  volumeUsd: "500000000000000000",
                  beneficiaries: [{ shares: "950000000000000000", beneficiary: router }],
                  quoteToken: { address: "0xmsft", symbol: "MSFT", name: "Microsoft" },
                  baseToken: { address: token, symbol: "DEVS", name: "Developers" },
                }],
              },
            },
          };
        },
      };
    }

    const method = body?.method;
    const params = body?.params ?? [];
    const rpcResult = (result) => ({
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: 1, result };
      },
    });

    if (method === "eth_call") {
      const data = params[0]?.data ?? "";
      if (data.startsWith("0x8e67e049")) return rpcResult("0x0000000000000000000000000000000000000000000000000000000000000001");
      if (data.startsWith("0x4e3fda2a")) return rpcResult(router);
      if (data.startsWith("0x5fb6c6ed")) return rpcResult("0x0000000000000000000000000000000000000000000000000000000000000001");
      if (data.startsWith("0x3853922b")) return rpcResult(token);
      if (data.startsWith("0x036a9955")) return rpcResult("0x00000000000000000000000000000000000000c1");
      if (data.startsWith("0x29aa1617")) return rpcResult(token);
      if (data.startsWith("0x39191d7b")) return rpcResult("0x0000000000000000000000000000000000000d1");
      if (data.startsWith("0xcc8567eb")) return rpcResult("0x0000000000000000000000000000000000000000000000000000000000000001");
      if (data.startsWith("0x1aa8685b")) return rpcResult("0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0");
      if (data.startsWith("0x4def65ee")) return rpcResult("0x0000000000000000000000000000000000000000000000000000000000000001");
      if (data.startsWith("0x0ab29808")) return rpcResult(router);
      if (data.startsWith("0xdef23dee")) return rpcResult("0x0000000000000000000000000000000000000000000000000000000000000000");
      if (data.startsWith("0x5dac9401")) return rpcResult("0x0");
      if (data.startsWith("0x5ebb58fb")) return rpcResult("0x0000000000000000000000d870d302000000000000");
      return rpcResult("0x");
    }
    if (method === "eth_getLogs") return rpcResult([]);
    return rpcResult("0x");
  };

  const server = createServer({
    env: {
      EXECUTION_MODE: "disabled",
      UNIVERSAL_REWARDS_HUB: hub,
      PROJECT_ROUTER_FACTORY: factory,
      MANIFEST_DIR: `/tmp/pmd-directory-${Date.now()}`,
    },
    fetchImpl,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await request(server, "/v1/directory");
  assert.equal(response.status, 200);
  assert.equal(response.body.phase, "directory_live");
  assert.equal(response.body.verifiedContributorCount, 1);
  assert.equal(response.body.items[0].symbol, "DEVS");
  assert.equal(response.body.items[0].pairedStockSymbol, "MSFT");
  assert.equal(response.body.items[0].holderCount, 42);
});

test("platform endpoint exposes live factory and hub fields", async (t) => {
  const hub = "0x6844D0814E904722777A48Ae2CF7C4b8F78a19e5";
  const factory = "0x4AD615B99e2B6E8e2C322c657Ac8f81F1806A3a7";
  const server = createServer({
    env: {
      EXECUTION_MODE: "disabled",
      UNIVERSAL_REWARDS_HUB: hub,
      PROJECT_ROUTER_FACTORY: factory,
      TARGET_CHAIN: "robinhood",
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await request(server, "/v1/platform");
  assert.equal(response.status, 200);
  assert.equal(response.body.phase, "contracts_live");
  assert.equal(response.body.universalRewardsHub, hub);
  assert.equal(response.body.projectRouterFactory, factory);
  assert.equal(response.body.chainId, 4663);
});

test("public port falls back to the Railway-compatible port", () => {
  assert.equal(publicPortFrom({}), 3000);
  assert.equal(publicPortFrom({ PUBLIC_PORT: "8081" }), 8081);
  assert.equal(publicPortFrom({ PUBLIC_PORT: "invalid" }), 3000);
});

test("fetchBankrPairedStocks maps Robinhood RHJ assets for Bankr launches", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/rhj/assets")) {
      return {
        ok: true,
        async json() {
          return {
            assets: [{
              tokenSymbol: "AAPL",
              tokenName: "Apple • Robinhood Token",
              status: "ASSET_STATUS_ACTIVE",
              deployments: [{ chainId: 4663, contractAddress: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9" }],
              tradingCapabilities: { market: { whole: "TRADING_STATUS_TRADABLE" } },
            }, {
              tokenSymbol: "ZZZ",
              tokenName: "No Price • Robinhood Token",
              status: "ASSET_STATUS_ACTIVE",
              deployments: [{ chainId: 4663, contractAddress: "0x2" }],
              tradingCapabilities: { market: { whole: "TRADING_STATUS_TRADABLE" } },
            }],
          };
        },
      };
    }
    if (String(url).includes("/rhj/prices")) {
      return {
        ok: true,
        async json() {
          return {
            quotes: [{ tokenSymbol: "AAPL", bid: "100", ask: "101" }],
          };
        },
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  const payload = await fetchBankrPairedStocks(fetchImpl);
  assert.equal(payload.total, 1);
  assert.equal(payload.items[0].symbol, "AAPL");
  assert.equal(payload.source, "robinhood-rhj");
});

test("bankr paired stocks endpoint proxies registry data", async (t) => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/rhj/assets")) {
      return {
        ok: true,
        async json() {
          return {
            assets: [{
              tokenSymbol: "NVDA",
              tokenName: "NVIDIA • Robinhood Token",
              status: "ASSET_STATUS_ACTIVE",
              deployments: [{ chainId: 4663, contractAddress: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" }],
              tradingCapabilities: { market: { whole: "TRADING_STATUS_TRADABLE" } },
            }],
          };
        },
      };
    }
    return { ok: true, async json() { return { quotes: [{ tokenSymbol: "NVDA", bid: "1", ask: "2" }] }; } };
  };

  const server = createServer({ env: { EXECUTION_MODE: "disabled" }, fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await request(server, "/v1/bankr/paired-stocks");
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.items[0].symbol, "NVDA");
  assert.equal(response.body.source, "robinhood-rhj");
});

test("fetchBankrBeneficiaryFees filters robinhood stock-paired tokens", async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return {
        totalLaunches: 2,
        tokens: [
          {
            tokenAddress: "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3",
            name: "Developers",
            symbol: "DEVS",
            chain: "robinhood",
            poolId: "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0",
            share: "95.00%",
            token0Label: "DEVS",
            token1Label: "MSFT",
            source: "doppler",
          },
          {
            tokenAddress: "0x894fac757250f8e02180e1856957274d84ac4ba3",
            name: "RHAgent",
            symbol: "RHAGENT",
            chain: "robinhood",
            poolId: "0x1722e4a21c93af7afa508e93e41d7bcde665d68e00995b5e53bbf4f51e7f8174",
            share: "95.00%",
            token0Label: "WETH",
            token1Label: "RHAGENT",
            source: "doppler",
          },
        ],
      };
    },
  });

  const payload = await fetchBankrBeneficiaryFees("0x374d91a5674fa7cf86e725093b5848b97e1e13b4", fetchImpl);
  assert.equal(payload.eligibleCount, 1);
  assert.equal(payload.items[0].symbol, "DEVS");
  assert.equal(payload.items[0].pairedStockSymbol, "MSFT");
});

test("bankr beneficiary fees endpoint proxies wallet positions", async (t) => {
  const fetchImpl = async (url) => {
    if (String(url).includes("beneficiary-fees")) {
      return {
        ok: true,
        async json() {
          return {
            tokens: [{
              tokenAddress: "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3",
              symbol: "DEVS",
              chain: "robinhood",
              poolId: "0xabc",
              share: "95.00%",
              token0Label: "DEVS",
              token1Label: "MSFT",
            }],
          };
        },
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  const server = createServer({ env: { EXECUTION_MODE: "disabled" }, fetchImpl });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await request(server, "/v1/bankr/beneficiary-fees/0x374d91a5674fa7cf86e725093b5848b97e1e13b4");
  assert.equal(response.status, 200);
  assert.equal(response.body.eligibleCount, 1);
  assert.equal(response.body.items[0].symbol, "DEVS");
});

test("enrollment requests can be queued and listed", async (t) => {
  const manifestDir = `/tmp/pmd-enroll-${Date.now()}`;
  const server = createServer({
    env: { EXECUTION_MODE: "disabled", MANIFEST_DIR: manifestDir },
    now: () => "2026-09-01T00:00:00.000Z",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const post = await request(server, "/v1/enrollment-requests", {
    method: "POST",
    body: {
      tokenAddress: "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3",
      router: "0x80e2a6d2b1c0196a6d1d0101509b4ea5a56507c5",
      poolId: "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0",
      feeBeneficiary: "0x374d91a5674fa7cf86e725093b5848b97e1e13b4",
      tokenSymbol: "DEVS",
      pairedStockSymbol: "MSFT",
    },
  });
  assert.equal(post.status, 201);
  assert.equal(post.body.status, "queued");

  const list = await request(server, "/v1/enrollment-requests");
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].tokenSymbol, "DEVS");
});
