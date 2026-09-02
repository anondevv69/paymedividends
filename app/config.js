const ALLOWED_EXECUTION_MODES = new Set(["disabled", "keeper_dry_run", "keeper_live"]);
const ALLOWED_SWAP_QUOTE_PROVIDERS = new Set(["auto", "doppler", "0x"]);

export function platformConfig(env = process.env) {
  const executionMode = env.EXECUTION_MODE ?? "disabled";
  if (!ALLOWED_EXECUTION_MODES.has(executionMode)) {
    throw new Error("EXECUTION_MODE must be one of: disabled, keeper_dry_run, keeper_live.");
  }

  const swapQuoteProvider = String(env.SWAP_QUOTE_PROVIDER ?? "auto").toLowerCase();
  if (!ALLOWED_SWAP_QUOTE_PROVIDERS.has(swapQuoteProvider)) {
    throw new Error("SWAP_QUOTE_PROVIDER must be one of: auto, doppler, 0x.");
  }

  const keeperMinSettlementOut = BigInt(env.KEEPER_MIN_SETTLEMENT_OUT ?? "1");
  const swapSlippageBps = Number.parseInt(env.SWAP_SLIPPAGE_BPS ?? env.ZEROX_SLIPPAGE_BPS ?? "100", 10);

  return Object.freeze({
    executionMode,
    keeperPrivateKey: env.KEEPER_PRIVATE_KEY ?? null,
    keeperMinSettlementOut,
    swapQuoteProvider,
    swapSlippageBps,
    dopplerHttpProxy: env.DOPPLER_HTTP_PROXY ?? env.SWAP_QUOTE_HTTP_PROXY ?? null,
    memeToSettlementAdapter: env.MEME_TO_PAIRED_ADAPTER
      ?? env.MEME_TO_SPY_ADAPTER
      ?? env.MEME_TO_SETTLEMENT_ADAPTER
      ?? null,
    memeSwapExecutor: env.MEME_SWAP_EXECUTOR ?? null,
    governanceSafe: env.GOVERNANCE_SAFE ?? null,
    zeroXApiKey: env.ZEROX_API_KEY ?? null,
    zeroXSlippageBps: Number.parseInt(env.ZEROX_SLIPPAGE_BPS ?? "100", 10),
    platformFeeBps: Number(env.PLATFORM_FEE_BPS ?? 500),
    chain: env.TARGET_CHAIN ?? "unconfigured",
    projectRouterFactory: env.PROJECT_ROUTER_FACTORY ?? env.PAYOUT_VAULT_FACTORY ?? null,
    universalRewardsHub: env.UNIVERSAL_REWARDS_HUB ?? env.UNIVERSAL_REVENUE_VAULT ?? null,
    databaseConfigured: Boolean(env.DATABASE_URL),
    queueConfigured: Boolean(env.REDIS_URL),
    manifestDir: env.MANIFEST_DIR ?? null,
    robinhoodRpcUrl:
      env.ROBINHOOD_MAINNET_RPC_URL
      ?? env.ROBINHOOD_RPC_URL
      ?? "https://rpc.mainnet.chain.robinhood.com",
    // Fixed hourly cadence for fee/index/snapshot work. No separate round interval.
    workerPollIntervalMs: Math.max(
      Number.parseInt(env.WORKER_POLL_INTERVAL_MS ?? String(60 * 60 * 1000), 10),
      60 * 60 * 1000,
    ),
    enrollmentMinTotalHolders: Math.max(
      Number.parseInt(env.ENROLLMENT_MIN_TOTAL_HOLDERS ?? "100", 10),
      1,
    ),
    enrollmentMinQualifiedHolders: Math.max(
      Number.parseInt(env.ENROLLMENT_MIN_QUALIFIED_HOLDERS ?? "100", 10),
      1,
    ),
    enrollmentMinQualifiedBalance: BigInt(
      env.ENROLLMENT_MIN_QUALIFIED_BALANCE ?? "10000000",
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
