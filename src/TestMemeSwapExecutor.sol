// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IMemeSwapExecutor} from "./interfaces/IMemeSwapExecutor.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @notice Testnet/local executor that converts meme balances into a paired RWA 1:1 from a pre-funded pool.
contract TestMemeSwapExecutor is IMemeSwapExecutor {
    using SafeTransferLib for address;

    function fund(address token, uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function swapMemeToSettlement(
        address tokenIn,
        address outputAsset,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient
    ) external returns (uint256 amountOut) {
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = amountIn;
        if (amountOut < minimumAmountOut) revert();
        outputAsset.safeTransfer(recipient, amountOut);
    }
}
