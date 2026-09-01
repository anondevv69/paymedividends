import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { publicPortFrom } from "./config.js";
import { createServer, fetchBankrPairedStocks } from "./server.js";

async function request(server, path) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
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
