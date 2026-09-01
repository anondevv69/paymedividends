// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IProjectRouter} from "./interfaces/IProjectRouter.sol";
import {MerkleProofLib} from "./libraries/MerkleProofLib.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title UniversalRewardsHub
/// @notice Tokenless, multi-RWA reward Hub for verified member-token communities.
/// @dev Each equal-slice round reserves the same maximum amount for every active member community.
///      The holder allocation inside each community is supplied by a public offchain snapshot Merkle tree.
contract UniversalRewardsHub {
    using MerkleProofLib for bytes32[];
    using SafeTransferLib for address;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_HUB_FEE_BPS = 1_000;

    struct EqualSliceRound {
        address asset;
        uint64 snapshotBlock;
        uint64 claimDeadline;
        uint256 communityCount;
        uint256 submittedCommunityCount;
        uint256 allocationPerCommunity;
        bytes32 memberSetHash;
        bool finalized;
    }

    address public governance;
    address public opsTreasury;
    address public immutable settlementAsset;
    uint256 public immutable hubFeeBps;

    uint256 private reentrancyState = 1;
    uint256 public activeMemberCount;
    uint256 public roundCount;

    mapping(address => bool) public isApprovedAsset;
    mapping(address => bool) public isActiveMemberToken;
    mapping(address => address) public routerForMemberToken;
    mapping(address => address) public memberTokenForRouter;
    address[] private activeMemberTokens;

    mapping(address => uint256) public pendingRewards;
    mapping(address => uint256) public reservedRewards;
    mapping(address => uint256) public totalHubFeesPaid;

    mapping(uint256 => EqualSliceRound) private rounds;
    mapping(uint256 => mapping(address => bytes32)) public rootForMemberToken;
    mapping(uint256 => mapping(address => bool)) public roundIncludesMemberToken;
    mapping(uint256 => mapping(address => uint256)) public claimedByMemberToken;
    mapping(uint256 => mapping(address => bool)) public memberRoundClosed;
    mapping(uint256 => mapping(address => mapping(uint256 => bool))) public claimIndexUsed;

    event GovernanceTransferred(address indexed previousGovernance, address indexed newGovernance);
    event OpsTreasurySet(address indexed previousTreasury, address indexed newTreasury);
    event ApprovedAssetSet(address indexed asset, bool approved);
    event MemberRouterEnrolled(address indexed router, address indexed memberToken);
    event MemberRouterDeactivated(address indexed router, address indexed memberToken);
    event RewardsDeposited(address indexed depositor, address indexed asset, uint256 grossAmount, uint256 hubFee, uint256 netAmount);
    event EqualSliceRoundStarted(
        uint256 indexed roundId,
        address indexed asset,
        uint64 snapshotBlock,
        uint64 claimDeadline,
        uint256 allocationPerCommunity,
        uint256 communityCount
    );
    event MemberRootsAppended(uint256 indexed roundId, uint256 indexed startIndex, uint256 rootCount);
    event EqualSliceRoundFinalized(
        uint256 indexed roundId,
        bytes32 indexed memberSetHash,
        uint256 communityCount
    );
    event UnfinalizedRoundCancelled(
        uint256 indexed roundId,
        address indexed asset,
        uint256 amountReturnedToPending
    );
    event EqualSliceRoundCreated(
        uint256 indexed roundId,
        address indexed asset,
        uint64 snapshotBlock,
        uint64 claimDeadline,
        uint256 allocationPerCommunity,
        uint256 communityCount,
        bytes32 memberSetHash
    );
    event Claimed(
        uint256 indexed roundId, address indexed memberToken, address indexed account, uint256 claimIndex, uint256 amount
    );
    event ExpiredMemberAllocationReclaimed(uint256 indexed roundId, address indexed memberToken, uint256 amount);

    error ZeroAddress();
    error NotGovernance();
    error InvalidFee();
    error InvalidAsset();
    error InvalidRouter();
    error AlreadyEnrolled();
    error InvalidRound();
    error DuplicateMemberToken();
    error InvalidProof();
    error AlreadyClaimed();
    error ClaimWindowClosed();
    error ClaimWindowOpen();
    error ClaimExceedsCommunityAllocation();
    error Reentrancy();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(address governance_, address opsTreasury_, address settlementAsset_, uint256 hubFeeBps_) {
        if (governance_ == address(0) || opsTreasury_ == address(0) || settlementAsset_ == address(0)) {
            revert ZeroAddress();
        }
        if (hubFeeBps_ > MAX_HUB_FEE_BPS) revert InvalidFee();

        governance = governance_;
        opsTreasury = opsTreasury_;
        settlementAsset = settlementAsset_;
        hubFeeBps = hubFeeBps_;
        isApprovedAsset[settlementAsset_] = true;

        emit ApprovedAssetSet(settlementAsset_, true);
    }

    function transferGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceTransferred(governance, newGovernance);
        governance = newGovernance;
    }

    function setOpsTreasury(address newOpsTreasury) external onlyGovernance {
        if (newOpsTreasury == address(0)) revert ZeroAddress();
        emit OpsTreasurySet(opsTreasury, newOpsTreasury);
        opsTreasury = newOpsTreasury;
    }

    /// @notice Adds or removes an RWA/numerary asset accepted by the Hub.
    /// @dev Removing an asset with live accounting is forbidden so reserved claims cannot be stranded.
    function setApprovedAsset(address asset, bool approved) external onlyGovernance {
        if (asset == address(0)) revert ZeroAddress();
        if (!approved && (asset == settlementAsset || pendingRewards[asset] != 0 || reservedRewards[asset] != 0)) {
            revert InvalidAsset();
        }
        isApprovedAsset[asset] = approved;
        emit ApprovedAssetSet(asset, approved);
    }

    /// @notice Enrolls a bound Project Router after its live Bankr/Doppler fee-recipient relationship is verified.
    function enrollMemberRouter(address router, address memberToken) external onlyGovernance {
        if (router == address(0) || memberToken == address(0)) revert ZeroAddress();
        if (isActiveMemberToken[memberToken] || memberTokenForRouter[router] != address(0)) revert AlreadyEnrolled();

        IProjectRouter projectRouter = IProjectRouter(router);
        if (projectRouter.hub() != address(this) || projectRouter.communityToken() != memberToken || !projectRouter.poolBound()) {
            revert InvalidRouter();
        }

        isActiveMemberToken[memberToken] = true;
        routerForMemberToken[memberToken] = router;
        memberTokenForRouter[router] = memberToken;
        activeMemberTokens.push(memberToken);
        ++activeMemberCount;

        emit MemberRouterEnrolled(router, memberToken);
    }

    /// @notice Removes a router from future equal-slice rounds without affecting already-created claims.
    /// @dev Governance can subsequently enroll a newly verified router for the same member token.
    function deactivateMemberRouter(address memberToken) external onlyGovernance {
        if (!isActiveMemberToken[memberToken]) revert InvalidRouter();

        address router = routerForMemberToken[memberToken];
        isActiveMemberToken[memberToken] = false;
        routerForMemberToken[memberToken] = address(0);
        memberTokenForRouter[router] = address(0);
        --activeMemberCount;

        emit MemberRouterDeactivated(router, memberToken);
    }

    /// @notice Credits approved assets to the next shared reward round.
    /// @dev ERC-20 transfers made directly to this contract are not credited; callers must use this function.
    function deposit(address asset, uint256 amount) external nonReentrant returns (uint256 netAmount) {
        if (!isApprovedAsset[asset] || amount == 0) revert InvalidAsset();

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter <= balanceBefore) revert InvalidAsset();

        uint256 grossAmount = balanceAfter - balanceBefore;
        uint256 hubFee = (grossAmount * hubFeeBps) / BPS_DENOMINATOR;
        netAmount = grossAmount - hubFee;

        if (hubFee != 0) {
            asset.safeTransfer(opsTreasury, hubFee);
            totalHubFeesPaid[asset] += hubFee;
        }
        pendingRewards[asset] += netAmount;

        emit RewardsDeposited(msg.sender, asset, grossAmount, hubFee, netAmount);
    }

    /// @notice Starts a round, reserving an equal maximum allocation for every active member token.
    /// @dev Roots can then be appended in batches, which keeps the setup workable as membership grows.
    function startEqualSliceRound(address asset, uint64 snapshotBlock, uint64 claimDeadline)
        external
        onlyGovernance
        returns (uint256 roundId)
    {
        return _startEqualSliceRound(asset, snapshotBlock, claimDeadline);
    }

    /// @notice Appends a batch of member-token snapshot roots to a started round.
    function appendMemberRoots(uint256 roundId, address[] calldata memberTokens, bytes32[] calldata memberRoots)
        external
        onlyGovernance
    {
        _appendMemberRoots(roundId, memberTokens, memberRoots);
    }

    /// @notice Finalizes a fully populated round, making its community roots claimable.
    function finalizeEqualSliceRound(uint256 roundId) external onlyGovernance {
        _finalizeEqualSliceRound(roundId);
    }

    /// @notice Convenience method for small member sets. Large sets should use start/append/finalize.
    /// @dev The supplied roots are public manifest commitments. The contract enforces that no member
    ///      can claim more than the same per-community allocation in this round.
    function createEqualSliceRound(
        address asset,
        uint64 snapshotBlock,
        uint64 claimDeadline,
        address[] calldata memberTokens,
        bytes32[] calldata memberRoots
    ) external onlyGovernance returns (uint256 roundId) {
        roundId = _startEqualSliceRound(asset, snapshotBlock, claimDeadline);
        _appendMemberRoots(roundId, memberTokens, memberRoots);
        _finalizeEqualSliceRound(roundId);
    }

    /// @notice Claims an allocation from one member community's equal slice.
    /// @dev Leaf format: keccak256(abi.encodePacked(claimIndex, account, amount)).
    function claim(
        uint256 roundId,
        address memberToken,
        uint256 claimIndex,
        address account,
        uint256 amount,
        bytes32[] calldata proof
    ) external nonReentrant {
        EqualSliceRound memory round = rounds[roundId];
        if (round.asset == address(0) || !round.finalized || !roundIncludesMemberToken[roundId][memberToken]) {
            revert InvalidRound();
        }
        if (block.timestamp > round.claimDeadline || memberRoundClosed[roundId][memberToken]) revert ClaimWindowClosed();
        if (claimIndexUsed[roundId][memberToken][claimIndex]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(abi.encodePacked(claimIndex, account, amount));
        if (!proof.verify(rootForMemberToken[roundId][memberToken], leaf)) revert InvalidProof();

        uint256 newClaimed = claimedByMemberToken[roundId][memberToken] + amount;
        if (newClaimed > round.allocationPerCommunity) revert ClaimExceedsCommunityAllocation();

        claimIndexUsed[roundId][memberToken][claimIndex] = true;
        claimedByMemberToken[roundId][memberToken] = newClaimed;
        reservedRewards[round.asset] -= amount;
        round.asset.safeTransfer(account, amount);

        emit Claimed(roundId, memberToken, account, claimIndex, amount);
    }

    /// @notice Returns unclaimed balance from one expired member slice to the next reward pool.
    function reclaimExpiredMemberAllocation(uint256 roundId, address memberToken) external {
        EqualSliceRound memory round = rounds[roundId];
        if (round.asset == address(0) || !roundIncludesMemberToken[roundId][memberToken]) revert InvalidRound();
        if (block.timestamp <= round.claimDeadline) revert ClaimWindowOpen();
        if (memberRoundClosed[roundId][memberToken]) revert InvalidRound();

        memberRoundClosed[roundId][memberToken] = true;
        uint256 unclaimed = round.allocationPerCommunity - claimedByMemberToken[roundId][memberToken];
        if (unclaimed != 0) {
            reservedRewards[round.asset] -= unclaimed;
            pendingRewards[round.asset] += unclaimed;
        }

        emit ExpiredMemberAllocationReclaimed(roundId, memberToken, unclaimed);
    }

    /// @notice Safely returns a not-yet-finalized round's entire reserve to pending rewards.
    function cancelUnfinalizedRound(uint256 roundId) external onlyGovernance {
        EqualSliceRound memory round = rounds[roundId];
        if (round.asset == address(0) || round.finalized) revert InvalidRound();

        uint256 totalReserved = round.allocationPerCommunity * round.communityCount;
        reservedRewards[round.asset] -= totalReserved;
        pendingRewards[round.asset] += totalReserved;
        delete rounds[roundId];

        emit UnfinalizedRoundCancelled(roundId, round.asset, totalReserved);
    }

    function roundAt(uint256 roundId) external view returns (EqualSliceRound memory) {
        return rounds[roundId];
    }

    function memberTokenAt(uint256 index) external view returns (address) {
        return activeMemberTokens[index];
    }

    function _startEqualSliceRound(address asset, uint64 snapshotBlock, uint64 claimDeadline)
        private
        returns (uint256 roundId)
    {
        uint256 communityCount = activeMemberCount;
        if (
            !isApprovedAsset[asset] || communityCount == 0 || snapshotBlock >= block.number
                || claimDeadline <= block.timestamp
        ) revert InvalidRound();

        uint256 allocationPerCommunity = pendingRewards[asset] / communityCount;
        if (allocationPerCommunity == 0) revert InvalidRound();
        uint256 totalReserved = allocationPerCommunity * communityCount;

        roundId = ++roundCount;
        pendingRewards[asset] -= totalReserved;
        reservedRewards[asset] += totalReserved;
        rounds[roundId] = EqualSliceRound({
            asset: asset,
            snapshotBlock: snapshotBlock,
            claimDeadline: claimDeadline,
            communityCount: communityCount,
            submittedCommunityCount: 0,
            allocationPerCommunity: allocationPerCommunity,
            memberSetHash: bytes32(0),
            finalized: false
        });

        emit EqualSliceRoundStarted(
            roundId, asset, snapshotBlock, claimDeadline, allocationPerCommunity, communityCount
        );
    }

    function _appendMemberRoots(uint256 roundId, address[] calldata memberTokens, bytes32[] calldata memberRoots) private {
        EqualSliceRound storage round = rounds[roundId];
        uint256 rootCount = memberTokens.length;
        if (
            round.asset == address(0) || round.finalized || rootCount == 0 || memberRoots.length != rootCount
                || round.submittedCommunityCount + rootCount > round.communityCount
        ) revert InvalidRound();

        uint256 startIndex = round.submittedCommunityCount;
        bytes32 memberSetHash = round.memberSetHash;
        for (uint256 i; i < rootCount; ++i) {
            address memberToken = memberTokens[i];
            bytes32 memberRoot = memberRoots[i];
            if (!isActiveMemberToken[memberToken] || memberRoot == bytes32(0)) revert InvalidRound();
            if (roundIncludesMemberToken[roundId][memberToken]) revert DuplicateMemberToken();

            roundIncludesMemberToken[roundId][memberToken] = true;
            rootForMemberToken[roundId][memberToken] = memberRoot;
            memberSetHash = keccak256(abi.encode(memberSetHash, memberToken, memberRoot));
        }

        round.submittedCommunityCount += rootCount;
        round.memberSetHash = memberSetHash;
        emit MemberRootsAppended(roundId, startIndex, rootCount);
    }

    function _finalizeEqualSliceRound(uint256 roundId) private {
        EqualSliceRound storage round = rounds[roundId];
        if (round.asset == address(0) || round.finalized || round.submittedCommunityCount != round.communityCount) {
            revert InvalidRound();
        }
        round.finalized = true;

        emit EqualSliceRoundFinalized(roundId, round.memberSetHash, round.communityCount);
        emit EqualSliceRoundCreated(
            roundId,
            round.asset,
            round.snapshotBlock,
            round.claimDeadline,
            round.allocationPerCommunity,
            round.communityCount,
            round.memberSetHash
        );
    }
}
