import {
  decodeAddress,
  decodeBool,
  decodeBytes32,
  decodeUint256,
  encodeAddress,
  encodeCall,
  encodeUint256,
  ethCall,
  hexToNumber,
} from "./rpc.js";

const ROUTER_ABI = {
  routerCount: "0x8e67e049",
  routerAt: "0x4e3fda2a",
  poolBound: "0xcc8567eb",
  memeAssetPolicy: "0x6d10ade4",
  memeAsset: "0xb13c346f",
  pairedAsset: "0x39191d7b",
  dopplerPoolId: "0x1aa8685b",
  communityToken: "0x29aa1617",
  collectAndRouteBankrDopplerFees: "0x38df073f",
  processMemeAsset: "0x56b279e1",
  balanceOf: "0x70a08231",
};

export const MEME_ASSET_POLICY = {
  QuoteOnly: 0,
  Burn: 1,
  Lock: 2,
  SwapToSettlement: 3,
};

export async function listFactoryRouters(rpcUrl, factory, fetchImpl = fetch) {
  const countHex = await ethCall(rpcUrl, factory, ROUTER_ABI.routerCount, fetchImpl);
  const count = hexToNumber(countHex);
  const routers = [];
  for (let index = 0; index < count; index += 1) {
    const data = encodeCall(ROUTER_ABI.routerAt, encodeUint256(index));
    const router = decodeAddress(await ethCall(rpcUrl, factory, data, fetchImpl));
    routers.push(router.toLowerCase());
  }
  return routers;
}

export async function readRouterState(rpcUrl, router, fetchImpl = fetch) {
  const [poolBoundRaw, policyRaw, memeRaw, pairedRaw, poolIdRaw, tokenRaw] = await Promise.all([
    ethCall(rpcUrl, router, ROUTER_ABI.poolBound, fetchImpl),
    ethCall(rpcUrl, router, ROUTER_ABI.memeAssetPolicy, fetchImpl),
    ethCall(rpcUrl, router, ROUTER_ABI.memeAsset, fetchImpl),
    ethCall(rpcUrl, router, ROUTER_ABI.pairedAsset, fetchImpl),
    ethCall(rpcUrl, router, ROUTER_ABI.dopplerPoolId, fetchImpl),
    ethCall(rpcUrl, router, ROUTER_ABI.communityToken, fetchImpl),
  ]);

  const memeAsset = decodeAddress(memeRaw);
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const memeBalance = memeAsset !== zeroAddress
    ? decodeUint256(await ethCall(
      rpcUrl,
      memeAsset,
      encodeCall(ROUTER_ABI.balanceOf, encodeAddress(router)),
      fetchImpl,
    ))
    : 0n;

  return {
    router: router.toLowerCase(),
    poolBound: decodeBool(poolBoundRaw),
    memeAssetPolicy: Number(decodeUint256(policyRaw)),
    memeAsset,
    pairedAsset: decodeAddress(pairedRaw),
    communityToken: decodeAddress(tokenRaw),
    dopplerPoolId: decodeBytes32(poolIdRaw),
    memeBalance: memeBalance.toString(),
  };
}

export function buildCollectCalldata(minimumSettlementOut = 0n) {
  return encodeCall(ROUTER_ABI.collectAndRouteBankrDopplerFees, encodeUint256(minimumSettlementOut));
}

export function buildProcessMemeCalldata(minimumSettlementOut = 0n) {
  return encodeCall(ROUTER_ABI.processMemeAsset, encodeUint256(minimumSettlementOut));
}
