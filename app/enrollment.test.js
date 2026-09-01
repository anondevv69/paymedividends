import assert from "node:assert/strict";
import test from "node:test";
import { validateEnrollmentRequest } from "./enrollment.js";

test("validateEnrollmentRequest accepts a well-formed body", () => {
  const fields = validateEnrollmentRequest({
    tokenAddress: "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3",
    router: "0x80e2a6d2b1c0196a6d1d0101509b4ea5a56507c5",
    poolId: "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0",
    feeBeneficiary: "0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4",
    tokenSymbol: "DEVS",
    pairedStockSymbol: "MSFT",
    minQualifiedBalance: "10000000",
  });

  assert.equal(fields.tokenAddress, "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3");
  assert.equal(fields.status, "pending_governance");
  assert.equal(fields.pairedStockSymbol, "MSFT");
  assert.equal(fields.minQualifiedBalance, "10000000");
  assert.equal(fields.skipHolderChecks, false);
});

test("validateEnrollmentRequest skips holder checks for pmd launches", () => {
  const fields = validateEnrollmentRequest({
    tokenAddress: "0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3",
    router: "0x80e2a6d2b1c0196a6d1d0101509b4ea5a56507c5",
    poolId: "0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0",
    feeBeneficiary: "0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4",
    skipHolderChecks: true,
  });

  assert.equal(fields.skipHolderChecks, true);
  assert.equal(fields.launchSource, "pmd");
});

test("validateEnrollmentRequest rejects invalid addresses", () => {
  assert.throws(
    () => validateEnrollmentRequest({ tokenAddress: "bad", router: "0x1", poolId: "0x2", feeBeneficiary: "0x3" }),
    /invalid_token_address/,
  );
});
