import { DopplerSDK, getAddresses } from "@whetstone-research/doppler-sdk/evm";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  http,
} from "viem";
import { createViemHttpOptions, pickProxyUrl } from "./proxy-fetch.js";

const ROBINHOOD_CHAIN_ID = 4663;
const V4_SWAP_COMMAND = "0x10";
const V4_ACTIONS = encodePacked(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]);
const ROUTER_DEADLINE_SECONDS = 300;

const UNIVERSAL_ROUTER_ABI = [{
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [
    { name: "commands", type: "bytes" },
    { name: "inputs", type: "bytes[]" },
    { name: "deadline", type: "uint256" },
  ],
  outputs: [],
}];

const clientCache = new Map();

function robinhoodChain(rpcUrl) {
  return {
    id: ROBINHOOD_CHAIN_ID,
    name: "robinhood",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

function getPublicClient(rpcUrl, proxyUrl = null) {
  const key = `${rpcUrl ?? "default"}|${proxyUrl ?? "direct"}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, createPublicClient({
      chain: robinhoodChain(rpcUrl),
      transport: http(rpcUrl, createViemHttpOptions(proxyUrl)),
    }));
  }
  return clientCache.get(key);
}

function sameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

export function applySlippage(amount, slippageBps) {
  const bps = Math.min(Math.max(Number(slippageBps ?? 100), 0), 10_000);
  const minOut = (BigInt(amount) * BigInt(10_000 - bps)) / 10_000n;
  if (minOut <= 0n) throw new Error("amount_too_small_for_slippage");
  return minOut;
}

export function encodeRobinhoodUniversalRouterExactIn({
  poolKey,
  zeroForOne,
  amountIn,
  minAmountOut,
  inputCurrency,
  outputCurrency,
  deadline = BigInt(Math.floor(Date.now() / 1000) + ROUTER_DEADLINE_SECONDS),
}) {
  const swapParams = encodeAbiParameters(
    [{
      type: "tuple",
      components: [
        {
          name: "poolKey",
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
        { name: "zeroForOne", type: "bool" },
        { name: "amountIn", type: "uint128" },
        { name: "amountOutMinimum", type: "uint128" },
        { name: "minHopPriceX36", type: "uint256" },
        { name: "hookData", type: "bytes" },
      ],
    }],
    [{
      poolKey,
      zeroForOne,
      amountIn,
      amountOutMinimum: minAmountOut,
      minHopPriceX36: 0n,
      hookData: "0x",
    }],
  );
  const settleAll = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [inputCurrency, amountIn],
  );
  const takeAll = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [outputCurrency, minAmountOut],
  );
  const routerInput = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [V4_ACTIONS, [swapParams, settleAll, takeAll]],
  );
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [V4_SWAP_COMMAND, [routerInput], deadline],
  });
}

export async function fetchDopplerSwapQuote({
  meme,
  pairedAsset,
  sellAmount,
  rpcUrl,
  slippageBps = 100,
  proxyUrl = null,
}) {
  const sellAmountBn = BigInt(sellAmount);
  if (sellAmountBn <= 0n) throw new Error("doppler_sell_amount_required");

  const selectedProxy = pickProxyUrl(proxyUrl);
  const publicClient = getPublicClient(rpcUrl, selectedProxy);
  const sdk = new DopplerSDK({ publicClient, chainId: ROBINHOOD_CHAIN_ID });
  const addresses = getAddresses(ROBINHOOD_CHAIN_ID);

  const pool = await sdk.getMulticurvePool(meme);
  const state = await pool.getState();
  if (!sameAddress(state.asset, meme)) throw new Error("doppler_meme_mismatch");
  if (!sameAddress(state.numeraire, pairedAsset)) throw new Error("doppler_paired_asset_mismatch");

  const poolKey = state.poolKey;
  const inputIsCurrency0 = sameAddress(meme, poolKey.currency0);
  const inputIsCurrency1 = sameAddress(meme, poolKey.currency1);
  if (!inputIsCurrency0 && !inputIsCurrency1) throw new Error("doppler_pool_key_mismatch");
  const zeroForOne = inputIsCurrency0;

  const quote = await sdk.quoter.quoteExactInputV4({
    poolKey,
    zeroForOne,
    exactAmount: sellAmountBn,
    hookData: "0x",
  });
  const amountOut = BigInt(quote.amountOut);
  if (amountOut <= 0n) throw new Error("doppler_quote_unavailable");

  const minAmountOut = applySlippage(amountOut, slippageBps);
  const swapData = encodeRobinhoodUniversalRouterExactIn({
    poolKey,
    zeroForOne,
    amountIn: sellAmountBn,
    minAmountOut,
    inputCurrency: meme,
    outputCurrency: pairedAsset,
  });

  return {
    swapTarget: addresses.universalRouter,
    swapData,
    minBuyAmount: minAmountOut.toString(),
    buyAmount: amountOut.toString(),
    quoteSource: "doppler",
    poolKey,
    gasEstimate: quote.gasEstimate?.toString?.() ?? null,
    proxyUsed: Boolean(selectedProxy),
  };
}
