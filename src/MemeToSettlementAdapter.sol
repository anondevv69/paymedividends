// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IUniversalRewardsHub} from "./interfaces/IUniversalRewardsHub.sol";
import {ISwapToSettlementAdapter} from "./interfaces/ISwapToSettlementAdapter.sol";
import {IMemeSwapExecutor} from "./interfaces/IMemeSwapExecutor.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @notice Converts non-RWA meme fee balances into the pool's paired RWA (e.g. DEVS → MSFT).
/// @dev Approved RWA quote assets must never be sent here — routers deposit those directly to the Hub.
contract MemeToSettlementAdapter is ISwapToSettlementAdapter {
    using SafeTransferLib for address;

    address public immutable hub;
    address public immutable swapExecutor;

    error RwaUseDirectDeposit();
    error InvalidOutputAsset();
    error ZeroAmount();

    constructor(address hub_, address swapExecutor_) {
        if (hub_ == address(0) || swapExecutor_ == address(0)) revert();
        hub = hub_;
        swapExecutor = swapExecutor_;
    }

    function swapToSettlement(
        address tokenIn,
        address settlementAsset,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient
    ) external returns (uint256 amountOut) {
        if (!IUniversalRewardsHub(hub).isApprovedAsset(settlementAsset)) revert InvalidOutputAsset();
        if (amountIn == 0) revert ZeroAmount();
        if (IUniversalRewardsHub(hub).isApprovedAsset(tokenIn)) revert RwaUseDirectDeposit();

        if (tokenIn == settlementAsset) {
            tokenIn.safeTransferFrom(msg.sender, recipient, amountIn);
            return amountIn;
        }

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenIn.forceApprove(swapExecutor, amountIn);
        amountOut = IMemeSwapExecutor(swapExecutor)
            .swapMemeToSettlement(tokenIn, settlementAsset, amountIn, minimumAmountOut, recipient);
        tokenIn.forceApprove(swapExecutor, 0);
    }
}
