import { encodeSetRuntimeSwap } from "./safe-batch.js";
import { fetchDopplerSwapQuote } from "./doppler-quote.js";
import { fetchZeroExSwapQuote, quoteToRuntimeSwap } from "./swap-quote.js";

const ALLOWED_SWAP_QUOTE_PROVIDERS = new Set(["auto", "doppler", "0x"]);

export function resolveSwapQuoteProvider(value = "auto") {
  const provider = String(value ?? "auto").toLowerCase();
  if (!ALLOWED_SWAP_QUOTE_PROVIDERS.has(provider)) {
    throw new Error("swap_quote_provider_invalid");
  }
  return provider;
}

export function canPrepareRuntimeSwap(config) {
  if (!config.memeSwapExecutor) return false;
  const provider = config.swapQuoteProvider;
  if (provider === "doppler") return true;
  if (provider === "0x") return Boolean(config.zeroXApiKey);
  return true;
}

export async function prepareRuntimeSwap({
  config,
  meme,
  pairedAsset,
  sellAmount,
  fetchImpl = fetch,
}) {
  if (!config.memeSwapExecutor) throw new Error("meme_swap_executor_required");

  const provider = config.swapQuoteProvider;
  const slippageBps = config.swapSlippageBps;
  const errors = [];

  if (provider === "doppler" || provider === "auto") {
    try {
      const runtime = await fetchDopplerSwapQuote({
        meme,
        pairedAsset,
        sellAmount,
        rpcUrl: config.robinhoodRpcUrl,
        slippageBps,
        proxyUrl: config.dopplerHttpProxy,
      });
      return {
        ...runtime,
        calldata: encodeSetRuntimeSwap({
          meme,
          swapTarget: runtime.swapTarget,
          swapData: runtime.swapData,
        }),
      };
    } catch (error) {
      errors.push(error);
      if (provider === "doppler") throw error;
    }
  }

  if ((provider === "0x" || provider === "auto") && config.zeroXApiKey) {
    const quote = await fetchZeroExSwapQuote({
      sellToken: meme,
      buyToken: pairedAsset,
      sellAmount,
      taker: config.memeSwapExecutor,
      apiKey: config.zeroXApiKey,
      slippageBps,
      fetchImpl,
    });
    const runtime = quoteToRuntimeSwap(quote);
    return {
      ...runtime,
      quoteSource: "0x",
      calldata: encodeSetRuntimeSwap({
        meme,
        swapTarget: runtime.swapTarget,
        swapData: runtime.swapData,
      }),
    };
  }

  if (provider === "0x") throw new Error("zero_x_api_key_required");
  throw errors[0] ?? new Error("swap_quote_provider_unavailable");
}
