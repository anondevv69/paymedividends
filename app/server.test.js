import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { publicPortFrom } from "./config.js";
import { createServer } from "./server.js";

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

test("universal directory exposes only the configured v2 Hub address", async (t) => {
  const hub = "0x1111111111111111111111111111111111111111";
  const server = createServer({ env: { EXECUTION_MODE: "disabled", UNIVERSAL_REWARDS_HUB: hub } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await request(server, "/v1/universal");
  assert.equal(response.status, 200);
  assert.equal(response.body.phase, "awaiting_indexer");
  assert.equal(response.body.universalRewardsHub, hub);
  assert.deepEqual(response.body.contributors, []);
});

test("public port falls back to the Railway-compatible port", () => {
  assert.equal(publicPortFrom({}), 3000);
  assert.equal(publicPortFrom({ PUBLIC_PORT: "8081" }), 8081);
  assert.equal(publicPortFrom({ PUBLIC_PORT: "invalid" }), 3000);
});
