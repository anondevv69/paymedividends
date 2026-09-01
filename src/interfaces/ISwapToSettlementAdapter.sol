// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Fixed-route adapter boundary for one approved conversion policy.
/// @dev A production adapter must independently enforce its route, TWAP, deadline, and price-impact policy.
///      The ProjectRouter never accepts arbitrary calldata or an arbitrary destination asset.
interface ISwapToSettlementAdapter {
    function swapToSettlement(
        address tokenIn,
        address settlementAsset,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient
    ) external returns (uint256 amountOut);
}
