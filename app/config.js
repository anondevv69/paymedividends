const ALLOWED_EXECUTION_MODES = new Set(["disabled"]);

export function platformConfig(env = process.env) {
  const executionMode = env.EXECUTION_MODE ?? "disabled";
  if (!ALLOWED_EXECUTION_MODES.has(executionMode)) {
    throw new Error("EXECUTION_MODE must remain disabled until the live keeper has been audited and approved.");
  }

  return Object.freeze({
    executionMode,
    platformFeeBps: Number(env.PLATFORM_FEE_BPS ?? 500),
    chain: env.TARGET_CHAIN ?? "unconfigured",
    projectRouterFactory: env.PROJECT_ROUTER_FACTORY ?? env.PAYOUT_VAULT_FACTORY ?? null,
    universalRewardsHub: env.UNIVERSAL_REWARDS_HUB ?? env.UNIVERSAL_REVENUE_VAULT ?? null,
    databaseConfigured: Boolean(env.DATABASE_URL),
    queueConfigured: Boolean(env.REDIS_URL),
    manifestDir: env.MANIFEST_DIR ?? null,
    workerPollIntervalMs: Math.max(Number.parseInt(env.WORKER_POLL_INTERVAL_MS ?? "1800000", 10), 30_000),
    rewardRoundIntervalMs: Math.max(
      Number.parseInt(env.REWARD_ROUND_INTERVAL_MS ?? String(60 * 60 * 1000), 10),
      30_000,
    ),
  });
}

export function portFrom(env = process.env) {
  return validPort(env.PORT, 3000);
}

export function publicPortFrom(env = process.env) {
  return validPort(env.PUBLIC_PORT, 3000);
}

function validPort(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3000;
}
