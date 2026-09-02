// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IDopplerFeeManager} from "./interfaces/IDopplerFeeManager.sol";
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
    address public pairedAsset;
    address public feeManager;
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
    event LaunchBound(
        address indexed communityToken, address indexed pairedAsset, address indexed feeManager, bytes32 dopplerPoolId
    );
    event BankrDopplerFeesCollected(
        address indexed feeManager, bytes32 indexed poolId, uint256 pairedAmountReceived, uint256 memeAmountReceived
    );
    event ApprovedAssetRouted(address indexed asset, uint256 grossAmount, uint256 netAmount);
    event MemeAssetBurned(address indexed asset, uint256 amount);
    event MemeAssetLocked(address indexed asset, address indexed lockbox, uint256 amount);
    event UnexpectedMemeAssetHeld(address indexed asset, uint256 amount);
    event MemeAssetConvertedToSettlement(
        address indexed asset, uint256 amountIn, uint256 settlementAmountOut, uint256 hubNetAmount
    );

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
    function bindBankrDopplerLaunch(
        address communityToken_,
        address memeAsset_,
        address pairedAsset_,
        address feeManager_,
        bytes32 dopplerPoolId_
    ) external onlyProjectAdmin {
        if (poolBound) revert LaunchAlreadyBound();
        if (
            communityToken_ == address(0) || memeAsset_ == address(0) || pairedAsset_ == address(0)
                || feeManager_ == address(0) || dopplerPoolId_ == bytes32(0)
        ) {
            revert ZeroAddress();
        }
        // In this product, the Bankr meme token is also the member-token claim ticket.
        if (
            communityToken_ != memeAsset_ || pairedAsset_ == memeAsset_ || feeManager_.code.length == 0
                || !IUniversalRewardsHub(hub).isApprovedAsset(pairedAsset_)
                || !IUniversalRewardsHub(hub).isApprovedFeeManager(feeManager_)
        ) revert InvalidConfiguration();
        if (
            !IUniversalRewardsHub(hub).isApprovedPoolBinding(feeManager_, dopplerPoolId_, communityToken_, pairedAsset_)
                || IDopplerFeeManager(feeManager_).getShares(dopplerPoolId_, address(this))
                    < IUniversalRewardsHub(hub).minimumRouterFeeShare()
        ) {
            revert InvalidConfiguration();
        }

        communityToken = communityToken_;
        memeAsset = memeAsset_;
        pairedAsset = pairedAsset_;
        feeManager = feeManager_;
        dopplerPoolId = dopplerPoolId_;
        poolBound = true;

        emit LaunchBound(communityToken_, pairedAsset_, feeManager_, dopplerPoolId_);
    }

    /// @notice Collects this router's Bankr/Doppler fee share and forwards its approved quote asset.
    /// @dev Anyone can trigger collection. The fee manager pays only its configured beneficiary.
    function collectAndRouteBankrDopplerFees(uint256 minimumSettlementOut)
        external
        whenPoolBound
        nonReentrant
        returns (uint256 pairedAmountReceived, uint256 memeAmountReceived, uint256 hubNetAmount)
    {
        uint256 pairedBefore = IERC20(pairedAsset).balanceOf(address(this));
        uint256 memeBefore = IERC20(memeAsset).balanceOf(address(this));

        IDopplerFeeManager(feeManager).collectFees(dopplerPoolId);

        uint256 pairedAfter = IERC20(pairedAsset).balanceOf(address(this));
        uint256 memeAfter = IERC20(memeAsset).balanceOf(address(this));
        if (pairedAfter < pairedBefore || memeAfter < memeBefore) revert InvalidAsset();
        pairedAmountReceived = pairedAfter - pairedBefore;
        memeAmountReceived = memeAfter - memeBefore;
        if (pairedAmountReceived == 0 && memeAmountReceived == 0) revert InvalidAsset();

        if (pairedAfter != 0) hubNetAmount = _routeApprovedAsset(pairedAsset, pairedAfter);
        if (memeAfter != 0) {
            if (memeAssetPolicy == MemeAssetPolicy.QuoteOnly) {
                emit UnexpectedMemeAssetHeld(memeAsset, memeAfter);
            } else {
                _processMemeAsset(memeAfter, minimumSettlementOut);
            }
        }

        emit BankrDopplerFeesCollected(feeManager, dopplerPoolId, pairedAmountReceived, memeAmountReceived);
    }

    /// @notice Routes a received approved RWA/quote asset into the Hub.
    /// @dev Publicly callable so a keeper or community member can trigger it without custody authority.
    function routeApprovedAsset(address asset) external whenPoolBound nonReentrant returns (uint256 netAmount) {
        if (!IUniversalRewardsHub(hub).isApprovedAsset(asset) || asset == memeAsset) revert InvalidAsset();
        uint256 grossAmount = IERC20(asset).balanceOf(address(this));
        if (grossAmount == 0) revert InvalidAsset();
        netAmount = _routeApprovedAsset(asset, grossAmount);
    }

    /// @notice Applies the fixed policy to a received Bankr meme-token fee balance.
    /// @dev Meme fees swap into the pool's paired RWA (e.g. DEVS → MSFT) and deposit to the Hub.
    ///      Tokenized stock / RWA fee legs are never swapped — they route directly via `_routeApprovedAsset`.
    function processMemeAsset(uint256 minimumSettlementOut)
        external
        whenPoolBound
        nonReentrant
        returns (uint256 settlementAmountOut, uint256 hubNetAmount)
    {
        uint256 amountIn = IERC20(memeAsset).balanceOf(address(this));
        if (amountIn == 0) revert InvalidAsset();

        return _processMemeAsset(amountIn, minimumSettlementOut);
    }

    function _routeApprovedAsset(address asset, uint256 grossAmount) private returns (uint256 netAmount) {
        asset.forceApprove(hub, grossAmount);
        netAmount = IUniversalRewardsHub(hub).deposit(asset, grossAmount);
        asset.forceApprove(hub, 0);

        emit ApprovedAssetRouted(asset, grossAmount, netAmount);
    }

    function _processMemeAsset(uint256 amountIn, uint256 minimumSettlementOut)
        private
        returns (uint256 settlementAmountOut, uint256 hubNetAmount)
    {
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

        address outputAsset = pairedAsset;
        uint256 balanceBefore = IERC20(outputAsset).balanceOf(address(this));
        memeAsset.forceApprove(swapAdapter, amountIn);
        ISwapToSettlementAdapter(swapAdapter)
            .swapToSettlement(memeAsset, outputAsset, amountIn, minimumSettlementOut, address(this));
        memeAsset.forceApprove(swapAdapter, 0);

        uint256 balanceAfter = IERC20(outputAsset).balanceOf(address(this));
        if (balanceAfter < balanceBefore) revert UnsafeSettlement();
        settlementAmountOut = balanceAfter - balanceBefore;
        if (settlementAmountOut < minimumSettlementOut) revert UnsafeSettlement();

        outputAsset.forceApprove(hub, settlementAmountOut);
        hubNetAmount = IUniversalRewardsHub(hub).deposit(outputAsset, settlementAmountOut);
        outputAsset.forceApprove(hub, 0);

        emit MemeAssetConvertedToSettlement(memeAsset, amountIn, settlementAmountOut, hubNetAmount);
    }
}
