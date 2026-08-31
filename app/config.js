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
    factoryAddress: env.PAYOUT_VAULT_FACTORY ?? null,
    databaseConfigured: Boolean(env.DATABASE_URL),
    queueConfigured: Boolean(env.REDIS_URL),
  });
}

export function portFrom(env = process.env) {
  const parsed = Number.parseInt(env.PORT ?? "3000", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3000;
}

