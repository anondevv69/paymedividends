import {
  decodeBool,
  encodeAddress,
  encodeBool,
  encodeBytes32,
  encodeCall,
  ethCall,
} from "./rpc.js";

const HUB_ABI = {
  isApprovedAsset: "0x5b5e3c13",
  isApprovedFeeManager: "0xe97d60dc",
  isApprovedPoolBinding: "0x5108fbb3",
  setApprovedAsset: "0x6e49c8b2",
  setApprovedFeeManager: "0x57ceaca8",
  setApprovedPoolBinding: "0xac332154",
};

const DEFAULT_FEE_MANAGER = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544";

export async function readHubRoutePrerequisites({
  rpcUrl,
  hub,
  meme,
  pairedAsset,
  poolId,
  feeManager = DEFAULT_FEE_MANAGER,
  fetchImpl = fetch,
}) {
  const [assetApprovedRaw, feeManagerApprovedRaw, poolBindingRaw] = await Promise.all([
    ethCall(rpcUrl, hub, encodeCall(HUB_ABI.isApprovedAsset, encodeAddress(pairedAsset)), fetchImpl),
    ethCall(rpcUrl, hub, encodeCall(HUB_ABI.isApprovedFeeManager, encodeAddress(feeManager)), fetchImpl),
    poolId
      ? ethCall(
        rpcUrl,
        hub,
        encodeCall(
          HUB_ABI.isApprovedPoolBinding,
          `${encodeAddress(feeManager)}${encodeBytes32(poolId)}${encodeAddress(meme)}${encodeAddress(pairedAsset)}`,
        ),
        fetchImpl,
      )
      : "0x0",
  ]);

  return {
    pairedAssetApproved: decodeBool(assetApprovedRaw),
    feeManagerApproved: decodeBool(feeManagerApprovedRaw),
    poolBindingApproved: poolId ? decodeBool(poolBindingRaw) : null,
  };
}

export function buildSetApprovedAssetTx({ hub, asset, approved = true }) {
  return {
    to: hub,
    data: encodeCall(HUB_ABI.setApprovedAsset, `${encodeAddress(asset)}${encodeBool(approved)}`),
    contractMethod: {
      inputs: [
        { internalType: "address", name: "asset", type: "address" },
        { internalType: "bool", name: "approved", type: "bool" },
      ],
      name: "setApprovedAsset",
      payable: false,
    },
    contractInputsValues: { asset, approved: approved ? "true" : "false" },
    meta: { label: `Approve RWA asset ${asset}` },
  };
}

export function buildSetApprovedFeeManagerTx({ hub, feeManager, approved = true }) {
  return {
    to: hub,
    data: encodeCall(HUB_ABI.setApprovedFeeManager, `${encodeAddress(feeManager)}${encodeBool(approved)}`),
    contractMethod: {
      inputs: [
        { internalType: "address", name: "feeManager", type: "address" },
        { internalType: "bool", name: "approved", type: "bool" },
      ],
      name: "setApprovedFeeManager",
      payable: false,
    },
    contractInputsValues: { feeManager, approved: approved ? "true" : "false" },
    meta: { label: `Approve fee manager ${feeManager}` },
  };
}

export function buildSetApprovedPoolBindingTx({
  hub,
  feeManager,
  poolId,
  communityToken,
  pairedAsset,
  approved = true,
}) {
  return {
    to: hub,
    data: encodeCall(
      HUB_ABI.setApprovedPoolBinding,
      `${encodeAddress(feeManager)}${encodeBytes32(poolId)}${encodeAddress(communityToken)}${encodeAddress(pairedAsset)}${encodeBool(approved)}`,
    ),
    contractMethod: {
      inputs: [
        { internalType: "address", name: "feeManager", type: "address" },
        { internalType: "bytes32", name: "poolId", type: "bytes32" },
        { internalType: "address", name: "communityToken", type: "address" },
        { internalType: "address", name: "pairedAsset", type: "address" },
        { internalType: "bool", name: "approved", type: "bool" },
      ],
      name: "setApprovedPoolBinding",
      payable: false,
    },
    contractInputsValues: {
      feeManager,
      poolId,
      communityToken,
      pairedAsset,
      approved: approved ? "true" : "false",
    },
    meta: { label: `Approve pool binding ${communityToken} / ${pairedAsset}` },
  };
}

export async function buildHubSetupTransactions({
  rpcUrl,
  hub,
  route,
  feeManager = DEFAULT_FEE_MANAGER,
  fetchImpl = fetch,
}) {
  const prerequisites = await readHubRoutePrerequisites({
    rpcUrl,
    hub,
    meme: route.meme,
    pairedAsset: route.pairedAsset,
    poolId: route.poolId,
    feeManager,
    fetchImpl,
  });

  const transactions = [];
  if (!prerequisites.pairedAssetApproved) {
    transactions.push(buildSetApprovedAssetTx({ hub, asset: route.pairedAsset }));
  }
  if (!prerequisites.feeManagerApproved) {
    transactions.push(buildSetApprovedFeeManagerTx({ hub, feeManager }));
  }
  if (route.poolId && prerequisites.poolBindingApproved === false) {
    transactions.push(buildSetApprovedPoolBindingTx({
      hub,
      feeManager,
      poolId: route.poolId,
      communityToken: route.meme,
      pairedAsset: route.pairedAsset,
    }));
  }

  return { transactions, prerequisites };
}
