// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library MerkleProofLib {
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 computedHash = leaf;
        uint256 length = proof.length;
        for (uint256 i; i < length; ++i) {
            bytes32 proofElement = proof[i];
            computedHash = computedHash <= proofElement
                ? keccak256(abi.encodePacked(computedHash, proofElement))
                : keccak256(abi.encodePacked(proofElement, computedHash));
        }
        return computedHash == root;
    }
}

