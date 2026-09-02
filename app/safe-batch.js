const CHAIN_ID = 4663;

export function encodeRegisterMemeRouteSimple({ meme, pairedAsset, active = true }) {
  const selector = "114c55b6";
  const head = [
    meme.replace(/^0x/, "").toLowerCase().padStart(64, "0"),
    pairedAsset.replace(/^0x/, "").toLowerCase().padStart(64, "0"),
    active ? "1".padStart(64, "0") : "0".padStart(64, "0"),
  ].join("");
  return `0x${selector}${head}`;
}

export function encodeSetRuntimeSwap({ meme, swapTarget, swapData }) {
  const selector = "e47e6824";
  const bytes = swapData.replace(/^0x/, "");
  const byteLen = bytes.length / 2;
  const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0");
  return `0x${selector}${
    padAddress(meme)
  }${padAddress(swapTarget)}${padUint(96)}${padUint(byteLen)}${padded}`;
}

function padAddress(address) {
  return address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function padUint(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

export function buildSafeBatch({
  chainId = CHAIN_ID,
  name = "Register meme → paired RWA routes",
  description = "One-time governance setup for Pay Me Dividends sink tokens.",
  transactions,
}) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: {
      name,
      description,
      txBuilderVersion: "1.16.5",
    },
    transactions: transactions.map((tx) => ({
      to: tx.to,
      value: "0",
      data: tx.data,
      contractMethod: tx.contractMethod ?? null,
      contractInputsValues: tx.contractInputsValues ?? null,
    })),
  };
}

export function buildRegisterRouteTransaction({
  executor,
  meme,
  pairedAsset,
  active = true,
  tokenSymbol = null,
  pairedStockSymbol = null,
}) {
  return {
    to: executor,
    data: encodeRegisterMemeRouteSimple({ meme, pairedAsset, active }),
    contractMethod: {
      inputs: [
        { internalType: "address", name: "meme", type: "address" },
        { internalType: "address", name: "pairedAsset", type: "address" },
        { internalType: "bool", name: "active", type: "bool" },
      ],
      name: "registerMemeRouteSimple",
      payable: false,
    },
    contractInputsValues: {
      meme,
      pairedAsset,
      active: active ? "true" : "false",
    },
    meta: {
      label: tokenSymbol && pairedStockSymbol
        ? `${tokenSymbol} → ${pairedStockSymbol}`
        : `${meme} → ${pairedAsset}`,
    },
  };
}
