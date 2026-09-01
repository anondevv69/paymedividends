// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {ISwapToSettlementAdapter} from "./interfaces/ISwapToSettlementAdapter.sol";
import {IUniversalRewardsHub} from "./interfaces/IUniversalRewardsHub.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title ProjectRouter
/// @notice Isolated Bankr/Doppler fee-recipient router for one member community.
/// @dev The router never sends a non-approved asset into the Hub. Its meme-asset policy is fixed
///      at initialization, and its Bankr/Doppler pool binding can happen exactly once after launch.
contract ProjectRouter {
    using SafeTransferLib for address;

    enum MemeAssetPolicy {
        QuoteOnly,
        Burn,
        Lock,
        SwapToSettlement
    }

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    bool public initialized;
    bool public poolBound;
    uint256 private reentrancyState;

    address public hub;
    address public projectAdmin;
    address public communityToken;
    address public memeAsset;
    address public memeLockbox;
    address public swapAdapter;
    bytes32 public dopplerPoolId;
    MemeAssetPolicy public memeAssetPolicy;

    event Initialized(
        address indexed projectAdmin,
        address indexed hub,
        MemeAssetPolicy memeAssetPolicy,
        address memeLockbox,
        address swapAdapter
    );
    event LaunchBound(address indexed communityToken, address indexed memeAsset, bytes32 indexed dopplerPoolId);
    event ApprovedAssetRouted(address indexed asset, uint256 grossAmount, uint256 netAmount);
    event MemeAssetBurned(address indexed asset, uint256 amount);
    event MemeAssetLocked(address indexed asset, address indexed lockbox, uint256 amount);
    event MemeAssetConvertedToSettlement(address indexed asset, uint256 amountIn, uint256 settlementAmountOut, uint256 hubNetAmount);

    error AlreadyInitialized();
    error NotProjectAdmin();
    error ZeroAddress();
    error InvalidConfiguration();
    error LaunchAlreadyBound();
    error LaunchNotBound();
    error InvalidAsset();
    error InvalidPolicy();
    error UnsafeSettlement();
    error Reentrancy();

    modifier onlyProjectAdmin() {
        if (msg.sender != projectAdmin) revert NotProjectAdmin();
        _;
    }

    modifier whenPoolBound() {
        if (!poolBound) revert LaunchNotBound();
        _;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor() {
        // Protect the implementation itself. EIP-1167 clones have fresh storage and can initialize once.
        initialized = true;
    }

    function initialize(
        address projectAdmin_,
        address hub_,
        MemeAssetPolicy memeAssetPolicy_,
        address memeLockbox_,
        address swapAdapter_
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (projectAdmin_ == address(0) || hub_ == address(0)) revert ZeroAddress();
        if (memeAssetPolicy_ == MemeAssetPolicy.Lock && memeLockbox_ == address(0)) revert InvalidConfiguration();
        if (memeAssetPolicy_ == MemeAssetPolicy.SwapToSettlement && swapAdapter_ == address(0)) {
            revert InvalidConfiguration();
        }
        if (memeAssetPolicy_ != MemeAssetPolicy.Lock && memeLockbox_ != address(0)) revert InvalidConfiguration();
        if (memeAssetPolicy_ != MemeAssetPolicy.SwapToSettlement && swapAdapter_ != address(0)) {
            revert InvalidConfiguration();
        }

        initialized = true;
        reentrancyState = 1;
        projectAdmin = projectAdmin_;
        hub = hub_;
        memeAssetPolicy = memeAssetPolicy_;
        memeLockbox = memeLockbox_;
        swapAdapter = swapAdapter_;

        emit Initialized(projectAdmin_, hub_, memeAssetPolicy_, memeLockbox_, swapAdapter_);
    }

    /// @notice One-time post-launch binding. The caller uses this router as Bankr's fee recipient at launch.
    function bindBankrDopplerLaunch(address communityToken_, address memeAsset_, bytes32 dopplerPoolId_)
        external
        onlyProjectAdmin
    {
        if (poolBound) revert LaunchAlreadyBound();
        if (communityToken_ == address(0) || memeAsset_ == address(0) || dopplerPoolId_ == bytes32(0)) {
            revert ZeroAddress();
        }
        // In this product, the Bankr meme token is also the member-token claim ticket.
        if (communityToken_ != memeAsset_) revert InvalidConfiguration();

        communityToken = communityToken_;
        memeAsset = memeAsset_;
        dopplerPoolId = dopplerPoolId_;
        poolBound = true;

        emit LaunchBound(communityToken_, memeAsset_, dopplerPoolId_);
    }

    /// @notice Routes a received approved RWA/quote asset into the Hub.
    /// @dev Publicly callable so a keeper or community member can trigger it without custody authority.
    function routeApprovedAsset(address asset) external whenPoolBound nonReentrant returns (uint256 netAmount) {
        if (!IUniversalRewardsHub(hub).isApprovedAsset(asset) || asset == memeAsset) revert InvalidAsset();
        uint256 grossAmount = IERC20(asset).balanceOf(address(this));
        if (grossAmount == 0) revert InvalidAsset();

        asset.forceApprove(hub, grossAmount);
        netAmount = IUniversalRewardsHub(hub).deposit(asset, grossAmount);
        asset.forceApprove(hub, 0);

        emit ApprovedAssetRouted(asset, grossAmount, netAmount);
    }

    /// @notice Applies the fixed policy to a received Bankr meme-token fee balance.
    /// @dev Swap-to-settlement is intentionally unavailable without a fixed, audited adapter. The adapter must
    ///      independently enforce a route, deadline, TWAP/price impact, and a minimum-safe output policy.
    function processMemeAsset(uint256 minimumSettlementOut)
        external
        whenPoolBound
        nonReentrant
        returns (uint256 settlementAmountOut, uint256 hubNetAmount)
    {
        uint256 amountIn = IERC20(memeAsset).balanceOf(address(this));
        if (amountIn == 0) revert InvalidAsset();

        if (memeAssetPolicy == MemeAssetPolicy.QuoteOnly) revert InvalidPolicy();
        if (memeAssetPolicy == MemeAssetPolicy.Burn) {
            memeAsset.safeTransfer(BURN_ADDRESS, amountIn);
            emit MemeAssetBurned(memeAsset, amountIn);
            return (0, 0);
        }
        if (memeAssetPolicy == MemeAssetPolicy.Lock) {
            memeAsset.safeTransfer(memeLockbox, amountIn);
            emit MemeAssetLocked(memeAsset, memeLockbox, amountIn);
            return (0, 0);
        }
        if (minimumSettlementOut == 0) revert UnsafeSettlement();

        address settlement = IUniversalRewardsHub(hub).settlementAsset();
        uint256 balanceBefore = IERC20(settlement).balanceOf(address(this));
        memeAsset.forceApprove(swapAdapter, amountIn);
        ISwapToSettlementAdapter(swapAdapter).swapToSettlement(
            memeAsset, settlement, amountIn, minimumSettlementOut, address(this)
        );
        memeAsset.forceApprove(swapAdapter, 0);

        uint256 balanceAfter = IERC20(settlement).balanceOf(address(this));
        if (balanceAfter < balanceBefore) revert UnsafeSettlement();
        settlementAmountOut = balanceAfter - balanceBefore;
        if (settlementAmountOut < minimumSettlementOut) revert UnsafeSettlement();

        settlement.forceApprove(hub, settlementAmountOut);
        hubNetAmount = IUniversalRewardsHub(hub).deposit(settlement, settlementAmountOut);
        settlement.forceApprove(hub, 0);

        emit MemeAssetConvertedToSettlement(memeAsset, amountIn, settlementAmountOut, hubNetAmount);
    }
}
