import assert from "node:assert/strict";
import test from "node:test";
import { parseProxyUrl, pickProxyUrl } from "./proxy-fetch.js";

test("parseProxyUrl accepts standard http proxy URLs", () => {
  const parsed = parseProxyUrl("http://alice:secret@proxy.example:3128");
  assert.ok(parsed.startsWith("http://alice:secret@proxy.example:3128"));
});

test("parseProxyUrl accepts host:port:user:pass format", () => {
  assert.equal(
    parseProxyUrl("proxy.example:3128:alice:secret-token"),
    "http://alice:secret-token@proxy.example:3128",
  );
});

test("pickProxyUrl chooses one entry from a comma-separated list", () => {
  const selected = pickProxyUrl("proxy1.example:3128:a:b,proxy2.example:3128:c:d");
  assert.ok(
    selected === "http://a:b@proxy1.example:3128"
    || selected === "http://c:d@proxy2.example:3128",
  );
});
