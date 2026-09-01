import assert from "node:assert/strict";
import test from "node:test";
import { analyzeHolderBalances, parseQualifiedBalanceInput } from "./holder-stats.js";

test("parseQualifiedBalanceInput converts human token amounts to raw balances", () => {
  assert.equal(parseQualifiedBalanceInput("10000000", 18), 10_000_000n * 10n ** 18n);
});

test("analyzeHolderBalances evaluates total and qualified holder gates", () => {
  const threshold = 10n;
  const holders = [
    { account: "0x1", balance: 100n },
    { account: "0x2", balance: 10n },
    { account: "0x3", balance: 9n },
  ];

  const pass = analyzeHolderBalances(holders, {
    minQualifiedBalance: threshold,
    minQualifiedHolders: 2,
    minTotalHolders: 3,
  });
  assert.equal(pass.passed, true);
  assert.equal(pass.qualifiedHolders, 2);

  const fail = analyzeHolderBalances(holders, {
    minQualifiedBalance: threshold,
    minQualifiedHolders: 3,
    minTotalHolders: 3,
  });
  assert.equal(fail.passed, false);
  assert.equal(fail.gates.minQualifiedHolders.passed, false);
});
