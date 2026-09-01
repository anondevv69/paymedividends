import assert from "node:assert/strict";
import test from "node:test";
import { buildLeaderboard, deriveStatus, formatDirectoryResponse } from "./directory.js";
import { normalizeDopplerPool, parseUsdFixed } from "./doppler.js";

test("deriveStatus ranks enrolled ahead of router-only", () => {
  assert.equal(deriveStatus({ poolBound: true, feesVerified: true, hubActive: true }), "enrolled");
  assert.equal(deriveStatus({ enrollmentStatus: "pending_governance", poolBound: true }), "enrollment_pending");
  assert.equal(deriveStatus({ feesVerified: true, poolBound: true }), "fees_verified");
  assert.equal(deriveStatus({ poolBound: true }), "pool_bound");
  assert.equal(deriveStatus({}), "router_created");
});

test("parseUsdFixed converts 18-decimal fixed values", () => {
  const usd = parseUsdFixed("34409032942788000000000");
  assert.ok(usd > 0);
});

test("buildLeaderboard sorts by market cap", () => {
  const board = buildLeaderboard([
    { tokenAddress: "0x1", symbol: "A", marketCapUsd: 10, holderCount: 1, status: "enrolled" },
    { tokenAddress: "0x2", symbol: "B", marketCapUsd: 100, holderCount: 2, status: "fees_verified" },
  ]);
  assert.equal(board[0].symbol, "B");
});

test("formatDirectoryResponse exposes contributors and items", () => {
  const payload = formatDirectoryResponse({
    hub: "0xhub",
    factory: "0xfactory",
    fetchedAt: "2026-09-01T00:00:00.000Z",
    totals: { hubEnrolled: 1, routers: 2, tokensTracked: 1, feesVerified: 1, enrollmentPending: 0, hubScheduled: 0 },
    leaderboard: [],
    items: [{
      tokenAddress: "0xtoken",
      router: "0xrouter",
      symbol: "DEVS",
      pairedStockSymbol: "MSFT",
      status: "enrolled",
      marketCapUsd: 1000,
      volumeUsd: 10,
      holderCount: 720,
      feesVerified: true,
      poolBound: true,
      hubActive: true,
      enrollmentStatus: null,
    }],
  });
  assert.equal(payload.verifiedContributorCount, 1);
  assert.equal(payload.contributors[0].symbol, "DEVS");
  assert.equal(payload.items[0].pairedStockSymbol, "MSFT");
});

test("normalizeDopplerPool extracts pair and beneficiary", () => {
  const normalized = normalizeDopplerPool({
    address: "0xpool",
    marketCapUsd: "1000000000000000000",
    holderCount: 10,
    volumeUsd: "0",
    beneficiaries: [{ shares: "950000000000000000", beneficiary: "0x374d91a5674fa7cf86e725093b5848b97e1e13b4" }],
    quoteToken: { address: "0xmsft", symbol: "MSFT", name: "Microsoft" },
    baseToken: { address: "0xdevs", symbol: "DEVS", name: "Developers" },
  });
  assert.equal(normalized.pairedStockSymbol, "MSFT");
  assert.equal(normalized.feeBeneficiary, "0x374d91a5674fa7cf86e725093b5848b97e1e13b4");
});
