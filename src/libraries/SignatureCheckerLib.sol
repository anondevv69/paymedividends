// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal signature verification for EOAs and ERC-1271 smart accounts.
library SignatureCheckerLib {
    bytes4 internal constant EIP1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 internal constant SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    function isValidSignatureNow(address signer, bytes32 digest, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        if (signer.code.length != 0) {
            (bool ok, bytes memory result) =
                signer.staticcall(abi.encodeWithSelector(EIP1271_MAGIC_VALUE, digest, signature));
            bytes4 magic;
            if (result.length >= 32) {
                assembly ("memory-safe") {
                    magic := mload(add(result, 0x20))
                }
            }
            return ok && magic == EIP1271_MAGIC_VALUE;
        }

        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (uint256(s) > SECP256K1_HALF_ORDER || (v != 27 && v != 28)) return false;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }
}
