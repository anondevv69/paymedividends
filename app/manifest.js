import { keccak256 } from "ethereum-cryptography/keccak.js";
import { utf8ToBytes } from "ethereum-cryptography/utils.js";
import { buildMerkleTree, claimLeaf, getProof, toHex } from "./merkle.js";

/**
 * Build a pro-rata equal-slice community manifest from balances at one snapshot block.
 * Leaf format matches UniversalRewardsHub: keccak256(abi.encodePacked(claimIndex, account, amount)).
 */
export function buildCommunitySnapshot({
  memberToken,
  snapshotBlock,
  allocationPerCommunity,
  balances,
  generatedAt = new Date().toISOString(),
}) {
  if (!memberToken) throw new Error("member_token_required");
  if (!Number.isInteger(snapshotBlock) || snapshotBlock < 0) throw new Error("invalid_snapshot_block");
  if (allocationPerCommunity === undefined || BigInt(allocationPerCommunity) <= 0n) {
    throw new Error("invalid_allocation");
  }

  const allocation = BigInt(allocationPerCommunity);
  const holders = normalizeBalances(balances);
  const totalSupply = holders.reduce((sum, row) => sum + row.balance, 0n);
  if (totalSupply === 0n) throw new Error("empty_holder_set");

  let remaining = allocation;
  const claims = holders.map((row, claimIndex) => {
    let amount;
    if (claimIndex === holders.length - 1) {
      amount = remaining;
    } else {
      amount = (row.balance * allocation) / totalSupply;
      remaining -= amount;
    }
    return {
      claimIndex,
      account: row.account,
      balance: row.balance.toString(),
      amount: amount.toString(),
    };
  });

  const leaves = claims.map((claim) => claimLeaf(claim.claimIndex, claim.account, claim.amount));
  const tree = buildMerkleTree(leaves);
  const claimsWithProofs = claims.map((claim, index) => ({
    ...claim,
    proof: getProof(tree, index).map(toHex),
  }));

  const manifest = {
    version: 1,
    memberToken: memberToken.toLowerCase(),
    snapshotBlock,
    allocationPerCommunity: allocation.toString(),
    totalSupply: totalSupply.toString(),
    holderCount: claims.length,
    generatedAt,
    claims: claimsWithProofs,
  };

  const body = `${JSON.stringify(manifest)}\n`;
  const manifestHash = toHex(keccak256(utf8ToBytes(body)));
  const root = toHex(tree.root);

  return {
    root,
    manifest,
    manifestBody: body,
    manifestHash,
    manifestURI: `pmd://${manifestHash.slice(2)}`,
  };
}

function normalizeBalances(balances) {
  const merged = new Map();
  for (const entry of balances) {
    const account = String(entry.account ?? entry.address).toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(account)) throw new Error(`invalid_holder:${account}`);
    const balance = BigInt(entry.balance);
    if (balance <= 0n) continue;
    merged.set(account, (merged.get(account) ?? 0n) + balance);
  }

  return [...merged.entries()]
    .map(([account, balance]) => ({ account, balance }))
    .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}
