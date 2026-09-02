// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Fixed-route adapter boundary for converting meme fees into a paired RWA output.
/// @dev A production adapter must independently enforce its route, TWAP, deadline, and price-impact policy.
///      The ProjectRouter passes the pool's paired RWA as `settlementAsset` and never routes RWAs through here.
interface ISwapToSettlementAdapter {
    function swapToSettlement(
        address tokenIn,
        address settlementAsset,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient
    ) external returns (uint256 amountOut);
}
