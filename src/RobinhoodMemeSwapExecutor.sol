// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IUniversalRewardsHub} from "./interfaces/IUniversalRewardsHub.sol";
import {IMemeSwapExecutor} from "./interfaces/IMemeSwapExecutor.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice Governance-configured meme → paired RWA executor for Robinhood Chain.
/// @dev Governance can register a route once per meme. The keeper supplies fresh swap calldata
///      (e.g. from 0x) via setRuntimeSwap before ProjectRouter calls processMemeAsset.
contract RobinhoodMemeSwapExecutor is IMemeSwapExecutor {
    using SafeTransferLib for address;

    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    address public immutable hub;
    address public governance;
    address public swapOperator;

    struct MemeRoute {
        address pairedAsset;
        address swapTarget;
        bytes swapData;
        address tokenOut;
        bool active;
    }

    mapping(address => MemeRoute) public routes;
    mapping(address => address) private _runtimeSwapTarget;
    mapping(address => bytes) private _runtimeSwapData;

    event GovernanceTransferred(address indexed previousGovernance, address indexed newGovernance);
    event SwapOperatorSet(address indexed previousOperator, address indexed newOperator);
    event MemeRouteRegistered(
        address indexed meme, address indexed pairedAsset, address swapTarget, bool active
    );
    event RuntimeSwapPrepared(address indexed meme, address indexed swapTarget, uint256 swapDataLength);

    error NotGovernance();
    error NotSwapOperator();
    error RouteNotActive();
    error InvalidRoute();
    error SwapFailed();
    error InsufficientOutput();
    error MissingRuntimeSwap();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier onlySwapOperator() {
        if (msg.sender != swapOperator && msg.sender != governance) revert NotSwapOperator();
        _;
    }

    constructor(address hub_, address governance_) {
        if (hub_ == address(0) || governance_ == address(0)) revert();
        hub = hub_;
        governance = governance_;
        swapOperator = governance_;
    }

    function transferGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert();
        emit GovernanceTransferred(governance, newGovernance);
        governance = newGovernance;
    }

    function setSwapOperator(address newOperator) external onlyGovernance {
        if (newOperator == address(0)) revert();
        emit SwapOperatorSet(swapOperator, newOperator);
        swapOperator = newOperator;
    }

    /// @notice Register a meme route without fixed swap calldata. Keeper supplies calldata at execution time.
    function registerMemeRouteSimple(address meme, address pairedAsset, bool active) external onlyGovernance {
        if (meme == address(0) || pairedAsset == address(0)) revert InvalidRoute();
        if (!IUniversalRewardsHub(hub).isApprovedAsset(pairedAsset)) revert InvalidRoute();

        routes[meme] = MemeRoute({
            pairedAsset: pairedAsset,
            swapTarget: address(0),
            swapData: "",
            tokenOut: pairedAsset,
            active: active
        });

        emit MemeRouteRegistered(meme, pairedAsset, address(0), active);
    }

    /// @notice Optional legacy path with fixed external swap calldata.
    function registerMemeRoute(
        address meme,
        address pairedAsset,
        address swapTarget,
        bytes calldata swapData,
        address tokenOut,
        bool active
    ) external onlyGovernance {
        if (meme == address(0) || pairedAsset == address(0)) revert InvalidRoute();
        if (!IUniversalRewardsHub(hub).isApprovedAsset(pairedAsset)) revert InvalidRoute();
        if (swapTarget == address(0) || swapData.length == 0 || tokenOut != pairedAsset) revert InvalidRoute();

        routes[meme] = MemeRoute({
            pairedAsset: pairedAsset,
            swapTarget: swapTarget,
            swapData: swapData,
            tokenOut: tokenOut,
            active: active
        });

        emit MemeRouteRegistered(meme, pairedAsset, swapTarget, active);
    }

    /// @notice Keeper prepares a fresh quote-based swap for the next adapter call in the same block window.
    function setRuntimeSwap(address meme, address swapTarget, bytes calldata swapData) external onlySwapOperator {
        MemeRoute memory route = routes[meme];
        if (!route.active) revert RouteNotActive();
        if (swapTarget == address(0) || swapData.length == 0) revert InvalidRoute();
        _runtimeSwapTarget[meme] = swapTarget;
        _runtimeSwapData[meme] = swapData;
        emit RuntimeSwapPrepared(meme, swapTarget, swapData.length);
    }

    function swapMemeToSettlement(
        address tokenIn,
        address outputAsset,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address recipient
    ) external returns (uint256 amountOut) {
        MemeRoute memory route = routes[tokenIn];
        if (!route.active) revert RouteNotActive();
        if (outputAsset != route.pairedAsset) revert InvalidRoute();

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);

        address swapTarget = route.swapTarget;
        bytes memory swapData = route.swapData;
        if (_runtimeSwapData[tokenIn].length > 0) {
            swapTarget = _runtimeSwapTarget[tokenIn];
            swapData = _runtimeSwapData[tokenIn];
            delete _runtimeSwapTarget[tokenIn];
            delete _runtimeSwapData[tokenIn];
        } else if (swapTarget == address(0) || swapData.length == 0) {
            revert MissingRuntimeSwap();
        }

        uint256 before = IERC20(route.tokenOut).balanceOf(address(this));
        _authorizeSwapInput(tokenIn, swapTarget, amountIn);
        (bool ok,) = swapTarget.call(swapData);
        tokenIn.forceApprove(swapTarget, 0);
        if (swapTarget == UNIVERSAL_ROUTER) {
            tokenIn.forceApprove(PERMIT2, 0);
        }
        if (!ok) revert SwapFailed();

        uint256 afterBalance = IERC20(route.tokenOut).balanceOf(address(this));
        if (afterBalance < before) revert SwapFailed();
        amountOut = afterBalance - before;

        if (amountOut < minimumAmountOut) revert InsufficientOutput();
        outputAsset.safeTransfer(recipient, amountOut);
    }

    /// @dev Robinhood's Universal Router pulls ERC-20 input through Permit2, not direct allowance.
    function _authorizeSwapInput(address tokenIn, address swapTarget, uint256 amountIn) internal {
        tokenIn.forceApprove(swapTarget, amountIn);
        if (swapTarget != UNIVERSAL_ROUTER) return;

        tokenIn.forceApprove(PERMIT2, amountIn);
        uint160 permitAmount = amountIn > type(uint160).max ? type(uint160).max : uint160(amountIn);
        IPermit2(PERMIT2).approve(tokenIn, swapTarget, permitAmount, uint48(block.timestamp + 1 hours));
    }
}
