// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Fixed-route executor used by MemeToSettlementAdapter.
interface IMemeSwapExecutor {
    function swapMemeToSettlement(
        address tokenIn,
        address settlementAsset,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient
    ) external returns (uint256 amountOut);
}
