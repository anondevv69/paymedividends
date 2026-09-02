const ADDRESS = /^0x[a-f0-9]{40}$/i;

export function pad32(hex) {
  return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

export function encodeAddress(address) {
  if (!ADDRESS.test(address)) throw new Error(`invalid_address:${address}`);
  return pad32(address);
}

export function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

export function encodeBool(value) {
  return value ? "1".padStart(64, "0") : "0".padStart(64, "0");
}

export function encodeBytes32(value) {
  const hex = String(value ?? "").replace(/^0x/, "").toLowerCase();
  if (hex.length !== 64) throw new Error(`invalid_bytes32:${value}`);
  return hex;
}

export function encodeCall(selector, encodedArgs = "") {
  const sig = selector.replace(/^0x/, "").toLowerCase();
  return `0x${sig}${encodedArgs.replace(/^0x/, "")}`;
}

export async function rpcCall(rpcUrl, method, params, fetchImpl = fetch, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const message = payload.error?.message ?? `rpc_${method}_failed`;
      if (attempt < retries && /too many requests|rate limit|429/i.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        lastError = new Error(message);
        continue;
      }
      throw new Error(message);
    }
    return payload.result;
  }
  throw lastError ?? new Error(`rpc_${method}_failed`);
}

export async function ethCall(rpcUrl, to, data, fetchImpl = fetch) {
  const result = await rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"], fetchImpl);
  return result ?? "0x";
}

export async function ethGetLogs(rpcUrl, filter, fetchImpl = fetch) {
  return rpcCall(rpcUrl, "eth_getLogs", [filter], fetchImpl);
}

export function decodeAddress(word) {
  const hex = String(word ?? "0x").replace(/^0x/, "").toLowerCase();
  if (!hex) return "0x0000000000000000000000000000000000000000";
  return `0x${hex.slice(-40).padStart(40, "0")}`;
}

export function decodeUint256(hex) {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

export function decodeBool(hex) {
  return decodeUint256(hex) !== 0n;
}

export function decodeBytes32(hex) {
  if (!hex || hex === "0x") return null;
  return `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

export function hexToNumber(hex) {
  return Number(decodeUint256(hex));
}
