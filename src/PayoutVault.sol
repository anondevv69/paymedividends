// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPayoutSwapAdapter} from "./interfaces/IPayoutSwapAdapter.sol";
import {IDopplerFeeManager} from "./interfaces/IDopplerFeeManager.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {MerkleProofLib} from "./libraries/MerkleProofLib.sol";

/// @title PayoutVault
/// @notice One isolated payout program. Revenue is converted into the configured payout asset,
///         a fixed platform fee is paid, then the remainder is reserved for Merkle claims.
/// @dev Holder balances for arbitrary ERC-20s are indexed offchain at `checkpointBlock`; this
///      contract enforces the reserve and claims but cannot itself prove a historic holder set.
contract PayoutVault {
    using SafeTransferLib for address;
    using MerkleProofLib for bytes32[];

    uint16 public constant MAX_PLATFORM_FEE_BPS = 1_000;
    uint16 private constant BPS_DENOMINATOR = 10_000;

    struct Round {
        uint64 checkpointBlock;
        uint32 recipientCount;
        uint32 claimedCount;
        uint256 amountReserved;
        uint256 amountClaimed;
        bytes32 merkleRoot;
    }

    bool public initialized;
    bool public launchBound;
    bool public paused;
    uint256 private reentrancyState;

    address public creator;
    address public keeper;
    address public holderToken;
    address public sourceAsset;
    address public payoutAsset;
    address public swapAdapter;
    address public platformTreasury;
    address public dopplerFeeManager;
    uint16 public platformFeeBps;
    uint256 public minimumRoundPayout;
    bytes32 public dopplerPoolId;

    uint256 public roundCount;
    uint256 public unallocatedPayout;
    uint256 public reservedForClaims;
    uint256 public totalPlatformFeesPaid;

    mapping(uint256 => Round) private rounds;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event Initialized(
        address indexed creator,
        address indexed holderToken,
        address indexed payoutAsset,
        address sourceAsset,
        address swapAdapter,
        address platformTreasury,
        uint16 platformFeeBps,
        uint256 minimumRoundPayout,
        address keeper
    );
    event PayoutAssetSwapped(uint256 sourceAmount, uint256 payoutReceived, uint256 minimumReceived);
    event PrelaunchInitialized(
        address indexed creator,
        address indexed payoutAsset,
        address indexed platformTreasury,
        uint16 platformFeeBps,
        uint256 minimumRoundPayout,
        address keeper
    );
    event BankrDopplerLaunchBound(
        address indexed holderToken,
        address indexed sourceAsset,
        address indexed feeManager,
        bytes32 poolId,
        address swapAdapter
    );
    event DopplerFeesClaimed(
        address indexed feeManager,
        bytes32 indexed poolId,
        uint256 payoutAssetReceived,
        uint256 sourceAssetReceived,
        uint256 platformFee,
        uint256 amountForHolders
    );
    event RevenueSettled(uint256 grossPayout, uint256 platformFee, uint256 amountForHolders);
    event RoundOpened(
        uint256 indexed roundId,
        uint64 indexed checkpointBlock,
        bytes32 indexed merkleRoot,
        uint32 recipientCount,
        uint256 amountReserved
    );
    event Claimed(uint256 indexed roundId, address indexed account, uint256 amount);
    event PauseSet(bool paused);
    event KeeperSet(address indexed previousKeeper, address indexed newKeeper);

    error AlreadyInitialized();
    error LaunchAlreadyBound();
    error LaunchNotBound();
    error DopplerNotConfigured();
    error NotCreator();
    error NotKeeper();
    error ZeroAddress();
    error InvalidConfiguration();
    error InvalidFee();
    error Paused();
    error Reentrancy();
    error NothingToSettle();
    error InvalidAmount();
    error InsufficientPayoutReceived();
    error BadCheckpoint();
    error BadMerkleRoot();
    error BadProof();
    error AlreadyClaimed();
    error ClaimExceedsReserve();
    error AccountingInvariantBroken();

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier whenLaunchBound() {
        if (!launchBound) revert LaunchNotBound();
        _;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    function initialize(
        address creator_,
        address keeper_,
        address holderToken_,
        address sourceAsset_,
        address payoutAsset_,
        address swapAdapter_,
        address platformTreasury_,
        uint16 platformFeeBps_,
        uint256 minimumRoundPayout_
    ) external {
        if (
            creator_ == address(0) || keeper_ == address(0) || holderToken_ == address(0) || sourceAsset_ == address(0)
                || payoutAsset_ == address(0) || platformTreasury_ == address(0)
        ) revert ZeroAddress();
        if (sourceAsset_ == payoutAsset_ && swapAdapter_ != address(0)) revert InvalidConfiguration();
        if (sourceAsset_ != payoutAsset_ && swapAdapter_ == address(0)) revert InvalidConfiguration();

        _initializeBase(creator_, keeper_, payoutAsset_, platformTreasury_, platformFeeBps_, minimumRoundPayout_);
        holderToken = holderToken_;
        sourceAsset = sourceAsset_;
        swapAdapter = swapAdapter_;
        launchBound = true;

        emit Initialized(
            creator_,
            holderToken_,
            payoutAsset_,
            sourceAsset_,
            swapAdapter_,
            platformTreasury_,
            platformFeeBps_,
            minimumRoundPayout_,
            keeper_
        );
    }

    /// @notice Initializes a vault before a Bankr/Doppler token exists.
    /// @dev The creator receives the vault address, uses it as Bankr's fee recipient, and can bind
    ///      the returned token + pool metadata once. Payout processing is impossible before binding.
    function initializePrelaunch(
        address creator_,
        address keeper_,
        address payoutAsset_,
        address platformTreasury_,
        uint16 platformFeeBps_,
        uint256 minimumRoundPayout_
    ) external {
        _initializeBase(creator_, keeper_, payoutAsset_, platformTreasury_, platformFeeBps_, minimumRoundPayout_);
        emit PrelaunchInitialized(
            creator_, payoutAsset_, platformTreasury_, platformFeeBps_, minimumRoundPayout_, keeper_
        );
    }

    /// @notice Permanently binds a pre-launch vault to its Bankr/Doppler launch metadata.
    /// @param sourceAsset_ The non-payout asset that can optionally be swapped into `payoutAsset`.
    ///                     Use `payoutAsset` with a zero adapter for quote-only fee launches.
    function bindBankrDopplerLaunch(
        address holderToken_,
        address sourceAsset_,
        address swapAdapter_,
        address feeManager_,
        bytes32 poolId_
    ) external onlyCreator {
        if (launchBound) revert LaunchAlreadyBound();
        if (
            holderToken_ == address(0) || sourceAsset_ == address(0) || feeManager_ == address(0)
                || poolId_ == bytes32(0)
        ) {
            revert ZeroAddress();
        }
        if (sourceAsset_ == payoutAsset && swapAdapter_ != address(0)) revert InvalidConfiguration();
        if (sourceAsset_ != payoutAsset && swapAdapter_ == address(0)) revert InvalidConfiguration();

        holderToken = holderToken_;
        sourceAsset = sourceAsset_;
        swapAdapter = swapAdapter_;
        dopplerFeeManager = feeManager_;
        dopplerPoolId = poolId_;
        launchBound = true;

        emit BankrDopplerLaunchBound(holderToken_, sourceAsset_, feeManager_, poolId_, swapAdapter_);
    }

    /// @notice Claims a configured Bankr/Doppler pool's fee share into this vault and immediately
    ///         applies the platform split to payout-asset revenue.
    /// @dev The vault must be the fee beneficiary at launch (or be made beneficiary later). Amounts
    ///      are measured by token balance deltas rather than trusting the external return values.
    function claimBankrDopplerFees()
        external
        onlyKeeper
        whenLaunchBound
        whenNotPaused
        nonReentrant
        returns (
            uint256 payoutAssetReceived,
            uint256 sourceAssetReceived,
            uint256 platformFee,
            uint256 amountForHolders
        )
    {
        if (dopplerFeeManager == address(0) || dopplerPoolId == bytes32(0)) {
            revert DopplerNotConfigured();
        }
        uint256 payoutBalanceBefore = IERC20(payoutAsset).balanceOf(address(this));
        uint256 sourceBalanceBefore = sourceAsset == payoutAsset ? 0 : IERC20(sourceAsset).balanceOf(address(this));

        IDopplerFeeManager(dopplerFeeManager).collectFees(dopplerPoolId);

        uint256 payoutBalanceAfter = IERC20(payoutAsset).balanceOf(address(this));
        if (payoutBalanceAfter < payoutBalanceBefore) revert AccountingInvariantBroken();
        payoutAssetReceived = payoutBalanceAfter - payoutBalanceBefore;
        if (sourceAsset != payoutAsset) {
            uint256 sourceBalanceAfter = IERC20(sourceAsset).balanceOf(address(this));
            if (sourceBalanceAfter < sourceBalanceBefore) revert AccountingInvariantBroken();
            sourceAssetReceived = sourceBalanceAfter - sourceBalanceBefore;
        }

        if (payoutAssetReceived != 0) {
            (, platformFee, amountForHolders) = _settlePayoutRevenue();
        }
        emit DopplerFeesClaimed(
            dopplerFeeManager, dopplerPoolId, payoutAssetReceived, sourceAssetReceived, platformFee, amountForHolders
        );
    }

    /// @notice Converts source revenue into the configured payout asset and applies the platform split.
    /// @dev The adapter address is fixed when this vault is created. `routeData` is interpreted only
    ///      by that trusted adapter; the vault measures actual balance received instead of trusting a quote.
    function swapAndSettle(uint256 sourceAmount, uint256 minimumPayoutReceived, bytes calldata routeData)
        external
        onlyKeeper
        whenLaunchBound
        whenNotPaused
        nonReentrant
        returns (uint256 grossPayout, uint256 platformFee, uint256 amountForHolders)
    {
        if (sourceAsset == payoutAsset || swapAdapter == address(0)) revert InvalidConfiguration();
        if (sourceAmount == 0 || sourceAmount > IERC20(sourceAsset).balanceOf(address(this))) revert InvalidAmount();

        uint256 balanceBefore = IERC20(payoutAsset).balanceOf(address(this));
        sourceAsset.forceApprove(swapAdapter, sourceAmount);
        IPayoutSwapAdapter(swapAdapter).swap(sourceAsset, payoutAsset, sourceAmount, minimumPayoutReceived, routeData);
        sourceAsset.forceApprove(swapAdapter, 0);

        uint256 balanceAfter = IERC20(payoutAsset).balanceOf(address(this));
        if (balanceAfter < balanceBefore) revert AccountingInvariantBroken();
        uint256 received = balanceAfter - balanceBefore;
        if (received < minimumPayoutReceived) revert InsufficientPayoutReceived();
        emit PayoutAssetSwapped(sourceAmount, received, minimumPayoutReceived);

        return _settlePayoutRevenue();
    }

    /// @notice Applies the fixed platform fee to payout-asset revenue already received by this vault.
    /// @dev Use this directly when the launcher sends creator fees in the payout asset.
    function settlePayoutRevenue()
        external
        onlyKeeper
        whenLaunchBound
        whenNotPaused
        nonReentrant
        returns (uint256 grossPayout, uint256 platformFee, uint256 amountForHolders)
    {
        return _settlePayoutRevenue();
    }

    /// @notice Reserves a settled payout amount for a fixed, public holder snapshot and Merkle root.
    function openRound(uint64 checkpointBlock, bytes32 merkleRoot, uint32 recipientCount, uint256 amountReserved)
        external
        onlyKeeper
        whenLaunchBound
        whenNotPaused
        returns (uint256 roundId)
    {
        if (checkpointBlock >= block.number) revert BadCheckpoint();
        if (merkleRoot == bytes32(0)) revert BadMerkleRoot();
        if (recipientCount == 0 || amountReserved < minimumRoundPayout || amountReserved > unallocatedPayout) {
            revert InvalidAmount();
        }

        roundId = ++roundCount;
        rounds[roundId] = Round({
            checkpointBlock: checkpointBlock,
            recipientCount: recipientCount,
            claimedCount: 0,
            amountReserved: amountReserved,
            amountClaimed: 0,
            merkleRoot: merkleRoot
        });
        unallocatedPayout -= amountReserved;
        reservedForClaims += amountReserved;

        emit RoundOpened(roundId, checkpointBlock, merkleRoot, recipientCount, amountReserved);
    }

    /// @notice Claims an allocation from a sealed payout round.
    /// @dev Leaf encoding is `keccak256(abi.encode(roundId, account, amount))`.
    function claim(uint256 roundId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Round storage round = rounds[roundId];
        if (round.merkleRoot == bytes32(0)) revert BadMerkleRoot();
        if (amount == 0) revert InvalidAmount();
        if (claimed[roundId][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(abi.encode(roundId, msg.sender, amount));
        if (!proof.verify(round.merkleRoot, leaf)) revert BadProof();
        if (round.amountClaimed + amount > round.amountReserved) revert ClaimExceedsReserve();

        claimed[roundId][msg.sender] = true;
        round.amountClaimed += amount;
        round.claimedCount += 1;
        reservedForClaims -= amount;
        payoutAsset.safeTransfer(msg.sender, amount);

        emit Claimed(roundId, msg.sender, amount);
    }

    /// @notice The creator may pause or resume future swaps, settlements, and new rounds.
    ///         Existing holder claims remain available while paused.
    function setPaused(bool paused_) external onlyCreator {
        paused = paused_;
        emit PauseSet(paused_);
    }

    /// @notice Lets a creator rotate the automation wallet without changing any economic policy.
    function setKeeper(address newKeeper) external onlyCreator {
        if (newKeeper == address(0)) revert ZeroAddress();
        emit KeeperSet(keeper, newKeeper);
        keeper = newKeeper;
    }

    function roundInfo(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    function availableUnsettledPayout() public view returns (uint256) {
        uint256 payoutBalance = IERC20(payoutAsset).balanceOf(address(this));
        uint256 accounted = reservedForClaims + unallocatedPayout;
        if (payoutBalance < accounted) revert AccountingInvariantBroken();
        return payoutBalance - accounted;
    }

    function _settlePayoutRevenue()
        internal
        returns (uint256 grossPayout, uint256 platformFee, uint256 amountForHolders)
    {
        grossPayout = availableUnsettledPayout();
        if (grossPayout == 0) revert NothingToSettle();

        platformFee = (grossPayout * platformFeeBps) / BPS_DENOMINATOR;
        amountForHolders = grossPayout - platformFee;
        unallocatedPayout += amountForHolders;
        if (platformFee != 0) {
            totalPlatformFeesPaid += platformFee;
            payoutAsset.safeTransfer(platformTreasury, platformFee);
        }
        emit RevenueSettled(grossPayout, platformFee, amountForHolders);
    }

    function _initializeBase(
        address creator_,
        address keeper_,
        address payoutAsset_,
        address platformTreasury_,
        uint16 platformFeeBps_,
        uint256 minimumRoundPayout_
    ) private {
        if (initialized) revert AlreadyInitialized();
        if (
            creator_ == address(0) || keeper_ == address(0) || payoutAsset_ == address(0)
                || platformTreasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (platformFeeBps_ > MAX_PLATFORM_FEE_BPS) revert InvalidFee();
        if (minimumRoundPayout_ == 0) revert InvalidAmount();

        initialized = true;
        reentrancyState = 1;
        creator = creator_;
        keeper = keeper_;
        payoutAsset = payoutAsset_;
        platformTreasury = platformTreasury_;
        platformFeeBps = platformFeeBps_;
        minimumRoundPayout = minimumRoundPayout_;
    }

    /// @dev Supports Doppler fee paths that transfer a position NFT to the fee beneficiary.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }
}
