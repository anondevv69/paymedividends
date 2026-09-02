const ZEROX_QUOTE_URL = "https://api.0x.org/swap/allowance-holder/quote";

export async function fetchZeroExSwapQuote({
  sellToken,
  buyToken,
  sellAmount,
  taker,
  chainId = 4663,
  apiKey = process.env.ZEROX_API_KEY ?? null,
  slippageBps = 100,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    throw new Error("zero_x_api_key_required");
  }

  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount: String(sellAmount),
    taker,
    slippageBps: String(slippageBps),
  });

  const response = await fetchImpl(`${ZEROX_QUOTE_URL}?${params.toString()}`, {
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2",
    },
    signal: AbortSignal.timeout(30000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.detail ?? payload?.error ?? "zero_x_quote_failed");
  }

  return {
    sellToken,
    buyToken,
    sellAmount: String(sellAmount),
    buyAmount: payload.buyAmount ?? null,
    minBuyAmount: payload.minBuyAmount ?? null,
    transaction: {
      to: payload.transaction?.to?.toLowerCase() ?? null,
      data: payload.transaction?.data ?? null,
      value: payload.transaction?.value ?? "0",
      gas: payload.transaction?.gas ?? null,
    },
    issues: payload.issues ?? null,
    route: payload.route ?? null,
    raw: payload,
  };
}

export function quoteToRuntimeSwap(quote) {
  if (!quote?.transaction?.to || !quote?.transaction?.data) {
    throw new Error("zero_x_quote_missing_transaction");
  }
  return {
    swapTarget: quote.transaction.to,
    swapData: quote.transaction.data,
    minBuyAmount: quote.minBuyAmount,
    buyAmount: quote.buyAmount,
  };
}
