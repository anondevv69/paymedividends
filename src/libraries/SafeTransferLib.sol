// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal ERC-20 helpers that accept tokens returning no value or `true`.
library SafeTransferLib {
    error ERC20CallFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount));
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(bytes4(0x23b872dd), from, to, amount));
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        bytes memory callData = abi.encodeWithSelector(bytes4(0x095ea7b3), spender, amount);
        (bool ok, bytes memory returned) = token.call(callData);
        if (_didSucceed(ok, returned)) return;
        _callOptionalReturn(token, abi.encodeWithSelector(bytes4(0x095ea7b3), spender, 0));
        _callOptionalReturn(token, callData);
    }

    function _callOptionalReturn(address token, bytes memory callData) private {
        (bool ok, bytes memory returned) = token.call(callData);
        if (!_didSucceed(ok, returned)) revert ERC20CallFailed(token);
    }

    function _didSucceed(bool ok, bytes memory returned) private pure returns (bool) {
        return ok && (returned.length == 0 || (returned.length >= 32 && abi.decode(returned, (bool))));
    }
}
