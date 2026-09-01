import assert from "node:assert/strict";
import test from "node:test";
import { createWebServer } from "./server.js";

async function request(server, pathname) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const body = await response.text();
  await new Promise((resolve) => server.close(resolve));
  return { response, body };
}

test("serves the application and injects its API endpoint", async () => {
  const { response, body } = await request(createWebServer({ env: { PUBLIC_API_URL: "https://api.example.test" } }), "/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /https:\/\/api\.example\.test/);
  assert.match(body, /Launch with shared holder rewards/);
  assert.match(body, /Existing token → shared Hub/);
  assert.match(body, /Token contract address/);
  assert.match(body, /Resolved pool ID/);
  assert.match(body, /Look up token on Bankr/);
});

test("has an independent healthcheck", async () => {
  const { response, body } = await request(createWebServer(), "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(body), { status: "ok", service: "paymedividends-web" });
});
