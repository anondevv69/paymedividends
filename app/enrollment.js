import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const REQUEST_FILE = "enrollment-requests.jsonl";

export function enrollmentRequestPath(manifestDir) {
  if (!manifestDir) return null;
  return path.join(manifestDir, REQUEST_FILE);
}

export async function appendEnrollmentRequest(manifestDir, request) {
  const filePath = enrollmentRequestPath(manifestDir);
  if (!filePath) throw new Error("manifest_dir_not_configured");
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(request)}\n`;
  await appendFile(filePath, line, "utf8");
  return filePath;
}

export async function listEnrollmentRequests(manifestDir, { limit = 50 } = {}) {
  const filePath = enrollmentRequestPath(manifestDir);
  if (!filePath) return [];
  try {
    const body = await readFile(filePath, "utf8");
    const lines = body.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line)).reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function parseEnrollmentGateInputs(body, defaults = {}) {
  const minTotalHolders = body?.minTotalHolders ?? defaults.minTotalHolders ?? 100;
  const minQualifiedHolders = body?.minQualifiedHolders ?? defaults.minQualifiedHolders ?? 100;
  const minQualifiedBalance = body?.minQualifiedBalance ?? defaults.minQualifiedBalance ?? "10000000";
  const skipHolderChecks = Boolean(body?.skipHolderChecks ?? body?.launchSource === "pmd");

  if (!Number.isInteger(Number(minTotalHolders)) || Number(minTotalHolders) < 1) {
    throw new Error("invalid_min_total_holders");
  }
  if (!Number.isInteger(Number(minQualifiedHolders)) || Number(minQualifiedHolders) < 1) {
    throw new Error("invalid_min_qualified_holders");
  }
  if (!/^\d+$/.test(String(minQualifiedBalance))) {
    throw new Error("invalid_min_qualified_balance");
  }

  return {
    minTotalHolders: Number(minTotalHolders),
    minQualifiedHolders: Number(minQualifiedHolders),
    minQualifiedBalance: String(minQualifiedBalance),
    skipHolderChecks,
  };
}

export function validateEnrollmentRequest(body, defaults = {}) {
  const tokenAddress = String(body?.tokenAddress ?? "").toLowerCase();
  const router = String(body?.router ?? "").toLowerCase();
  const poolId = String(body?.poolId ?? "").toLowerCase();
  const feeBeneficiary = String(body?.feeBeneficiary ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(tokenAddress)) throw new Error("invalid_token_address");
  if (!/^0x[a-f0-9]{40}$/.test(router)) throw new Error("invalid_router");
  if (!/^0x[a-f0-9]{64}$/.test(poolId)) throw new Error("invalid_pool_id");
  if (!/^0x[a-f0-9]{40}$/.test(feeBeneficiary)) throw new Error("invalid_fee_beneficiary");

  const gates = parseEnrollmentGateInputs(body, defaults);

  return {
    tokenAddress,
    router,
    poolId,
    feeBeneficiary,
    tokenSymbol: body?.tokenSymbol ?? null,
    pairedStockSymbol: body?.pairedStockSymbol ?? null,
    chain: "robinhood",
    status: "pending_governance",
    launchSource: body?.launchSource ?? (gates.skipHolderChecks ? "pmd" : "external"),
    ...gates,
  };
}

export function attachHolderQualification(request, holderStats) {
  return {
    ...request,
    holderQualification: {
      passed: holderStats.passed,
      skipped: false,
      source: holderStats.source,
      checkedAt: holderStats.checkedAt,
      totalHolders: holderStats.totalHolders,
      qualifiedHolders: holderStats.qualifiedHolders,
      minQualifiedBalanceHuman: holderStats.minQualifiedBalanceHuman,
      minQualifiedBalanceRaw: holderStats.minQualifiedBalanceRaw,
      gates: holderStats.gates,
    },
  };
}

export function attachSkippedHolderQualification(request, reason = "pmd_launch") {
  return {
    ...request,
    holderQualification: {
      passed: true,
      skipped: true,
      reason,
      checkedAt: new Date().toISOString(),
    },
  };
}
