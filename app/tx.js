import { secp256k1 } from "ethereum-cryptography/secp256k1.js";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { rpcCall } from "./rpc.js";

const ROBINHOOD_CHAIN_ID = 4663n;

function stripHex(value) {
  return value.replace(/^0x/, "");
}

function toHex(value) {
  if (typeof value === "bigint") {
    if (value === 0n) return "0x";
    return `0x${value.toString(16)}`;
  }
  if (typeof value === "number") return toHex(BigInt(value));
  if (value.startsWith("0x")) return value;
  return `0x${value}`;
}

function encodeRlpItem(value) {
  if (Array.isArray(value)) return encodeRlpList(value);
  if (typeof value === "bigint") {
    if (value === 0n) return new Uint8Array([0x80]);
    const hex = value.toString(16);
    const bytes = hex.length % 2 === 0
      ? Uint8Array.from(hex.match(/.{1,2}/g).map((byte) => Number.parseInt(byte, 16)))
      : Uint8Array.from(`0${hex}`.match(/.{1,2}/g).map((byte) => Number.parseInt(byte, 16)));
    if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
    return concatBytes(new Uint8Array([0x80 + bytes.length]), bytes);
  }
  if (value instanceof Uint8Array) {
    if (value.length === 1 && value[0] < 0x80) return value;
    return concatBytes(new Uint8Array([0x80 + value.length]), value);
  }
  throw new Error("unsupported_rlp_value");
}

function encodeRlpList(items) {
  const encoded = items.map(encodeRlpItem);
  const length = encoded.reduce((sum, item) => sum + item.length, 0);
  const prefix = length < 56
    ? new Uint8Array([0xc0 + length])
    : concatBytes(new Uint8Array([0xf7 + byteLength(length)]), toLengthBytes(length));
  return concatBytes(prefix, ...encoded);
}

function byteLength(value) {
  if (value === 0) return 1;
  return Math.ceil(value.toString(16).length / 2);
}

function toLengthBytes(length) {
  const hex = length.toString(16);
  const bytes = hex.length % 2 === 0
    ? hex.match(/.{1,2}/g).map((byte) => Number.parseInt(byte, 16))
    : `0${hex}`.match(/.{1,2}/g).map((byte) => Number.parseInt(byte, 16));
  return Uint8Array.from(bytes);
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function privateKeyToAddress(privateKeyHex) {
  const privateKey = Uint8Array.from(stripHex(privateKeyHex).match(/.{1,2}/g).map((byte) => Number.parseInt(byte, 16)));
  const publicKey = secp256k1.getPublicKey(privateKey, false).slice(1);
  const hash = keccak256(publicKey);
  return `0x${Buffer.from(hash).subarray(-20).toString("hex")}`;
}

function signDigest(digest, privateKeyHex) {
  const privateKey = Uint8Array.from(stripHex(privateKeyHex).match(/.{1,2}/g).map((byte) => Number.parseInt(byte, 16)));
  const signature = secp256k1.sign(digest, privateKey);
  const r = signature.r.toString(16).padStart(64, "0");
  const s = signature.s.toString(16).padStart(64, "0");
  const v = signature.recovery + 35 + Number(ROBINHOOD_CHAIN_ID) * 2;
  return { r: `0x${r}`, s: `0x${s}`, v };
}

export async function sendLegacyTransaction({
  rpcUrl,
  privateKey,
  to,
  data = "0x",
  value = 0n,
  gasLimit = null,
  gasPrice = null,
  nonce = null,
  fetchImpl = fetch,
}) {
  const from = privateKeyToAddress(privateKey);
  const resolvedNonce = nonce ?? BigInt(await rpcCall(
    rpcUrl,
    "eth_getTransactionCount",
    [from, "pending"],
    fetchImpl,
  ));
  const resolvedGasPrice = gasPrice ?? BigInt(await rpcCall(rpcUrl, "eth_gasPrice", [], fetchImpl));
  const tx = {
    nonce: resolvedNonce,
    gasPrice: resolvedGasPrice,
    gasLimit: gasLimit ?? BigInt(await rpcCall(rpcUrl, "eth_estimateGas", [{
      from,
      to,
      data,
      value: toHex(value),
    }], fetchImpl)),
    to,
    value,
    data: Uint8Array.from(stripHex(data).match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []),
    chainId: ROBINHOOD_CHAIN_ID,
  };

  const unsigned = [
    tx.nonce,
    tx.gasPrice,
    tx.gasLimit,
    tx.to,
    tx.value,
    tx.data,
    tx.chainId,
    0n,
    0n,
  ];
  const digest = keccak256(encodeRlpList(unsigned));
  const { r, s, v } = signDigest(digest, privateKey);
  const signed = [
    tx.nonce,
    tx.gasPrice,
    tx.gasLimit,
    tx.to,
    tx.value,
    tx.data,
    BigInt(v),
    BigInt(r),
    BigInt(s),
  ];
  const raw = `0x${Buffer.from(encodeRlpList(signed)).toString("hex")}`;
  return rpcCall(rpcUrl, "eth_sendRawTransaction", [raw], fetchImpl);
}
