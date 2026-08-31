import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
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

