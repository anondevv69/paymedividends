import { keccak256 } from "ethereum-cryptography/keccak.js";
import { bytesToHex, hexToBytes } from "ethereum-cryptography/utils.js";

function toBytes32(value) {
  const hex = BigInt(value).toString(16).padStart(64, "0");
  return hexToBytes(hex);
}

function toAddressBytes(address) {
  const normalized = address.toLowerCase().replace(/^0x/, "");
  if (normalized.length !== 40) throw new Error("invalid_address");
  return hexToBytes(normalized);
}

export function claimLeaf(claimIndex, account, amount) {
  const packed = new Uint8Array(84);
  packed.set(toBytes32(claimIndex), 0);
  packed.set(toAddressBytes(account), 32);
  packed.set(toBytes32(amount), 52);
  return keccak256(packed);
}

function hashPair(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0
    ? keccak256(concat(a, b))
    : keccak256(concat(b, a));
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function buildMerkleTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new Error("empty_leaves");
  }

  const layers = [leaves.map((leaf) => Uint8Array.from(leaf))];
  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 === current.length) {
        next.push(current[i]);
      } else {
        next.push(hashPair(current[i], current[i + 1]));
      }
    }
    layers.push(next);
  }

  return {
    root: layers[layers.length - 1][0],
    layers,
  };
}

export function getProof(tree, leafIndex) {
  const proof = [];
  let index = leafIndex;
  for (let layer = 0; layer < tree.layers.length - 1; layer += 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const siblings = tree.layers[layer];
    if (siblingIndex < siblings.length) {
      proof.push(siblings[siblingIndex]);
    }
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyProof(proof, root, leaf) {
  let computed = Uint8Array.from(leaf);
  for (const sibling of proof) {
    computed = hashPair(computed, sibling);
  }
  return bytesToHex(computed) === bytesToHex(root);
}

export function toHex(bytes) {
  return `0x${bytesToHex(bytes)}`;
}
