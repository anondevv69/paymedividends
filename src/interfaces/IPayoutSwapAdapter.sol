// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Chain- and venue-specific adapter trusted by a project vault.
/// @dev The adapter may pull at most the exact allowance granted for this call and must return
///      the output asset to `msg.sender` (the vault). A production adapter must enforce its own
///      route and router allowlists; arbitrary router calldata is intentionally not supported here.
interface IPayoutSwapAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes calldata routeData)
        external
        returns (uint256 amountOut);
}

