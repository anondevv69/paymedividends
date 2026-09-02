import assert from "node:assert/strict";
import test from "node:test";
import { applySlippage, encodeRobinhoodUniversalRouterExactIn } from "./doppler-quote.js";
import { prepareRuntimeSwap } from "./swap-provider.js";

const DEVS = "0x80db362eab104ec378e19d0a3dcd5e84bafd4ba3";
const MSFT = "0xe93237c50d904957cf27e7b1133b510c669c2e74";
const EXECUTOR = "0xc87498e933d624e40e791322191ab03c7335057e";
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";

test("applySlippage reduces output by configured bps", () => {
  assert.equal(applySlippage(1000n, 100), 990n);
  assert.equal(applySlippage(1000n, 0), 1000n);
});

test("encodeRobinhoodUniversalRouterExactIn builds execute calldata", () => {
  const data = encodeRobinhoodUniversalRouterExactIn({
    poolKey: {
      currency0: DEVS,
      currency1: MSFT,
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544",
    },
    zeroForOne: true,
    amountIn: 1_000_000_000_000_000_000n,
    minAmountOut: 600_000_000_000_000_000n,
    inputCurrency: DEVS,
    outputCurrency: MSFT,
    deadline: 1_700_000_000n,
  });
  assert.match(data, /^0x3593564c/);
});

test("prepareRuntimeSwap prefers doppler in auto mode", { skip: process.env.DOPPLER_QUOTE_LIVE !== "1" ? "set DOPPLER_QUOTE_LIVE=1 to run" : false }, async () => {
  const runtime = await prepareRuntimeSwap({
    config: {
      memeSwapExecutor: EXECUTOR,
      swapQuoteProvider: "auto",
      swapSlippageBps: 100,
      robinhoodRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
      zeroXApiKey: null,
    },
    meme: DEVS,
    pairedAsset: MSFT,
    sellAmount: 1_000_000_000_000_000_000n,
  });

  assert.equal(runtime.quoteSource, "doppler");
  assert.equal(runtime.swapTarget.toLowerCase(), UNIVERSAL_ROUTER);
  assert.match(runtime.calldata, /^0xe47e6824/);
  assert.ok(BigInt(runtime.minBuyAmount) > 0n);
});
