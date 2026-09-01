// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IDopplerFeeManager} from "./interfaces/IDopplerFeeManager.sol";
import {IProjectRouter} from "./interfaces/IProjectRouter.sol";
import {IProjectRouterFactory} from "./interfaces/IProjectRouterFactory.sol";
import {MerkleProofLib} from "./libraries/MerkleProofLib.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {SignatureCheckerLib} from "./libraries/SignatureCheckerLib.sol";

interface ISafeCommittee {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/// @title UniversalRewardsHub
/// @notice Tokenless, multi-RWA reward Hub for verified member-token communities.
/// @dev Each equal-slice round reserves the same maximum amount for every active member community.
///      The holder allocation inside each community is supplied by a public offchain snapshot Merkle tree.
contract UniversalRewardsHub {
    using MerkleProofLib for bytes32[];
    using SafeTransferLib for address;
    using SignatureCheckerLib for address;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_HUB_FEE_BPS = 1_000;
    uint64 public constant ROOT_REVIEW_DELAY = 24 hours;
    uint64 public constant MIN_POST_REVIEW_CLAIM_WINDOW = 7 days;
    uint64 public constant MAX_CLAIM_WINDOW = 90 days;
    uint64 public constant MEMBERSHIP_ACTIVATION_DELAY = 7 days;
    uint256 public constant minimumRouterFeeShare = 0.95e18;
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("PayMeDividends UniversalRewardsHub");
    bytes32 private constant VERSION_HASH = keccak256("2");
    bytes32 public constant MEMBER_ROOT_APPROVAL_TYPEHASH = keccak256(
        "MemberRootApproval(address hub,uint256 chainId,uint256 roundId,uint64 snapshotBlock,uint64 claimDeadline,address memberToken,bytes32 root,bytes32 manifestHash,bytes32 manifestURIHash,uint256 allocationPerCommunity)"
    );

    struct MembershipWindow {
        uint256 startRound;
        uint256 endRoundExclusive;
        address router;
    }

    struct EqualSliceRound {
        address asset;
        uint64 snapshotBlock;
        uint64 claimDeadline;
        uint256 communityCount;
        uint256 submittedCommunityCount;
        uint256 allocationPerCommunity;
        bytes32 memberSetHash;
        uint64 rootReviewEndsAt;
        bool finalized;
    }

    address public governance;
    address public opsTreasury;
    address public snapshotSigner;
    address public immutable settlementAsset;
    address public immutable routerFactory;
    uint256 public immutable hubFeeBps;

    uint256 private reentrancyState = 1;
    uint256 public activeMemberCount;
    uint256 public roundCount;

    mapping(address => bool) public isApprovedAsset;
    mapping(address => bool) public isApprovedFeeManager;
    mapping(bytes32 => bytes32) private approvedPoolBindingHashes;
    mapping(address => bool) public isActiveMemberToken;
    mapping(address => address) public routerForMemberToken;
    mapping(address => address) public memberTokenForRouter;
    mapping(address => address) public scheduledRouterForMemberToken;
    mapping(address => uint64) public memberActivationTime;
    mapping(address => MembershipWindow[]) private membershipWindows;
    address[] private activeMemberTokens;

    mapping(address => uint256) public pendingRewards;
    mapping(address => uint256) public reservedRewards;
    mapping(address => uint256) public totalHubFeesPaid;

    mapping(uint256 => EqualSliceRound) private rounds;
    mapping(uint256 => mapping(address => bytes32)) public rootForMemberToken;
    mapping(uint256 => mapping(address => bytes32)) public manifestHashForMemberToken;
    mapping(uint256 => mapping(address => string)) public manifestURIForMemberToken;
    mapping(uint256 => mapping(address => bool)) public roundIncludesMemberToken;
    mapping(uint256 => mapping(address => uint256)) public claimedByMemberToken;
    mapping(uint256 => mapping(address => bool)) public memberRoundClosed;
    mapping(uint256 => mapping(address => mapping(uint256 => bool))) public claimIndexUsed;
    /// @dev Permanently records vetoed EIP-712 digests so a previously published signature cannot be replayed.
    mapping(bytes32 => bool) public vetoedRootDigest;
    /// @dev Members who vetoed or were released as ineligible cannot re-enter the same round.
    mapping(uint256 => mapping(address => bool)) public memberForfeitedForRound;
    mapping(uint256 => address[]) private submittedMembersForRound;

    event GovernanceTransferred(address indexed previousGovernance, address indexed newGovernance);
    event OpsTreasurySet(address indexed previousTreasury, address indexed newTreasury);
    event SnapshotSignerSet(address indexed previousSigner, address indexed newSigner);
    event ApprovedAssetSet(address indexed asset, bool approved);
    event ApprovedFeeManagerSet(address indexed feeManager, bool approved);
    event BankrPoolBindingSet(
        address indexed feeManager,
        bytes32 indexed poolId,
        address indexed communityToken,
        address pairedAsset,
        bool approved
    );
    event MemberRouterScheduled(address indexed router, address indexed memberToken, uint64 activatesAt);
    event MemberRouterEnrolled(address indexed router, address indexed memberToken);
    event MemberRouterDeactivated(address indexed router, address indexed memberToken);
    event RewardsDeposited(
        address indexed depositor, address indexed asset, uint256 grossAmount, uint256 hubFee, uint256 netAmount
    );
    event EqualSliceRoundStarted(
        uint256 indexed roundId,
        address indexed asset,
        uint64 snapshotBlock,
        uint64 claimDeadline,
        uint256 allocationPerCommunity,
        uint256 communityCount
    );
    event MemberRootsAppended(
        uint256 indexed roundId, uint256 indexed startIndex, uint256 rootCount, uint64 rootReviewEndsAt
    );
    event MemberRootPublished(
        uint256 indexed roundId,
        address indexed memberToken,
        bytes32 indexed root,
        bytes32 manifestHash,
        string manifestURI
    );
    event MemberRootVetoed(uint256 indexed roundId, address indexed memberToken, address indexed projectAdmin);
    event MemberReleasedFromRound(
        uint256 indexed roundId, address indexed memberToken, uint256 allocationReturnedToPending
    );
    event EqualSliceRoundFinalized(uint256 indexed roundId, bytes32 indexed memberSetHash, uint256 communityCount);
    event UnfinalizedRoundCancelled(uint256 indexed roundId, address indexed asset, uint256 amountReturnedToPending);
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
        uint256 indexed roundId,
        address indexed memberToken,
        address indexed account,
        uint256 claimIndex,
        uint256 amount
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
    error InvalidSignature();
    error RootReviewOpen();
    error ActivationPending();
    error VetoedRoot();
    error ClaimWindowTooLong();
    error StillEligible();
    error InvalidSnapshotCommittee();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /// @dev Round creation is limited to governance or the snapshot committee Safe (expected 2-of-3).
    modifier onlyRoundOperator() {
        if (msg.sender != governance && msg.sender != snapshotSigner) revert NotGovernance();
        _;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert Reentrancy();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    constructor(
        address governance_,
        address opsTreasury_,
        address snapshotSigner_,
        address settlementAsset_,
        address routerFactory_,
        uint256 hubFeeBps_
    ) {
        if (
            governance_ == address(0) || opsTreasury_ == address(0) || snapshotSigner_ == address(0)
                || settlementAsset_ == address(0) || routerFactory_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (hubFeeBps_ > MAX_HUB_FEE_BPS) revert InvalidFee();
        _requireSnapshotCommittee(snapshotSigner_);

        governance = governance_;
        opsTreasury = opsTreasury_;
        snapshotSigner = snapshotSigner_;
        settlementAsset = settlementAsset_;
        routerFactory = routerFactory_;
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

    function setSnapshotSigner(address newSnapshotSigner) external onlyGovernance {
        _requireSnapshotCommittee(newSnapshotSigner);
        emit SnapshotSignerSet(snapshotSigner, newSnapshotSigner);
        snapshotSigner = newSnapshotSigner;
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

    /// @notice Allows governance to recognize Bankr/Doppler fee-manager contracts verified offchain.
    function setApprovedFeeManager(address feeManager, bool approved) external onlyGovernance {
        if (feeManager == address(0) || (approved && feeManager.code.length == 0)) revert InvalidRouter();
        isApprovedFeeManager[feeManager] = approved;
        emit ApprovedFeeManagerSet(feeManager, approved);
    }

    /// @notice Records a Bankr API / Doppler event-verified pool identity for onchain router binding.
    /// @dev Approvals require live fee-manager/asset allowlists. Revocations remain allowed after those
    ///      allowlists change so stale bindings can always be cleared.
    function setApprovedPoolBinding(
        address feeManager,
        bytes32 poolId,
        address communityToken,
        address pairedAsset,
        bool approved
    ) external onlyGovernance {
        if (feeManager == address(0) || poolId == bytes32(0) || communityToken == address(0) || pairedAsset == address(0))
        {
            revert InvalidRouter();
        }
        if (approved && (!isApprovedFeeManager[feeManager] || !isApprovedAsset[pairedAsset])) revert InvalidRouter();
        bytes32 key = keccak256(abi.encode(feeManager, poolId));
        approvedPoolBindingHashes[key] = approved ? keccak256(abi.encode(communityToken, pairedAsset)) : bytes32(0);
        emit BankrPoolBindingSet(feeManager, poolId, communityToken, pairedAsset, approved);
    }

    function isApprovedPoolBinding(address feeManager, bytes32 poolId, address communityToken, address pairedAsset)
        public
        view
        returns (bool)
    {
        return approvedPoolBindingHashes[keccak256(abi.encode(feeManager, poolId))]
            == keccak256(abi.encode(communityToken, pairedAsset));
    }

    /// @notice Schedules a factory-created router after its Bankr pool identity and fee share are verified.
    /// @dev v1 admission is curated by the governance Safe. Permissionless enrollment is intentionally
    ///      unavailable so zero-volume tokens cannot free-ride equal-slice rewards.
    function enrollMemberRouter(address router, address memberToken) external onlyGovernance {
        if (router == address(0) || memberToken == address(0)) revert ZeroAddress();
        if (
            isActiveMemberToken[memberToken] || scheduledRouterForMemberToken[memberToken] != address(0)
                || memberTokenForRouter[router] != address(0)
        ) revert AlreadyEnrolled();
        if (!IProjectRouterFactory(routerFactory).isProjectRouter(router)) revert InvalidRouter();
        _validateMemberRouter(router, memberToken);

        uint64 activatesAt = uint64(block.timestamp + MEMBERSHIP_ACTIVATION_DELAY);
        scheduledRouterForMemberToken[memberToken] = router;
        memberActivationTime[memberToken] = activatesAt;
        memberTokenForRouter[router] = memberToken;
        emit MemberRouterScheduled(router, memberToken, activatesAt);
    }

    /// @notice Activates a verified router after the public admission delay.
    /// @dev Re-checks pool binding, fee-manager allowlisting, and Doppler share so revoked or drifted
    ///      eligibility cannot activate after the seven-day window.
    function activateMemberRouter(address memberToken) external {
        address router = scheduledRouterForMemberToken[memberToken];
        if (router == address(0)) revert InvalidRouter();
        if (block.timestamp < memberActivationTime[memberToken]) revert ActivationPending();
        _validateMemberRouter(router, memberToken);

        delete scheduledRouterForMemberToken[memberToken];
        delete memberActivationTime[memberToken];
        isActiveMemberToken[memberToken] = true;
        routerForMemberToken[memberToken] = router;
        activeMemberTokens.push(memberToken);
        membershipWindows[memberToken].push(
            MembershipWindow({startRound: roundCount + 1, endRoundExclusive: 0, router: router})
        );
        ++activeMemberCount;

        emit MemberRouterEnrolled(router, memberToken);
    }

    function cancelScheduledMemberRouter(address memberToken) external onlyGovernance {
        address router = scheduledRouterForMemberToken[memberToken];
        if (router == address(0)) revert InvalidRouter();
        delete scheduledRouterForMemberToken[memberToken];
        delete memberActivationTime[memberToken];
        delete memberTokenForRouter[router];
    }

    /// @notice Removes a router from future equal-slice rounds without affecting already-created claims.
    /// @dev Governance can subsequently enroll a newly verified router for the same member token.
    function deactivateMemberRouter(address memberToken) external onlyGovernance {
        if (!isActiveMemberToken[memberToken]) revert InvalidRouter();

        address router = routerForMemberToken[memberToken];
        isActiveMemberToken[memberToken] = false;
        routerForMemberToken[memberToken] = address(0);
        memberTokenForRouter[router] = address(0);
        MembershipWindow[] storage windows = membershipWindows[memberToken];
        windows[windows.length - 1].endRoundExclusive = roundCount + 1;
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
        onlyRoundOperator
        returns (uint256 roundId)
    {
        return _startEqualSliceRound(asset, snapshotBlock, claimDeadline);
    }

    /// @notice Appends a batch of member-token snapshot roots to a started round.
    function appendMemberRoots(
        uint256 roundId,
        address[] calldata memberTokens,
        bytes32[] calldata memberRoots,
        bytes32[] calldata manifestHashes,
        string[] calldata manifestURIs,
        bytes[] calldata memberApprovals
    ) external {
        _appendMemberRoots(roundId, memberTokens, memberRoots, manifestHashes, manifestURIs, memberApprovals);
    }

    /// @notice Finalizes a fully populated round, making its community roots claimable.
    function finalizeEqualSliceRound(uint256 roundId) external {
        _finalizeEqualSliceRound(roundId);
    }

    /// @notice Convenience method that starts a small round and appends its attested roots.
    /// @dev Finalization remains a separate transaction after the mandatory public review delay.
    function prepareEqualSliceRound(
        address asset,
        uint64 snapshotBlock,
        uint64 claimDeadline,
        address[] calldata memberTokens,
        bytes32[] calldata memberRoots,
        bytes32[] calldata manifestHashes,
        string[] calldata manifestURIs,
        bytes[] calldata memberApprovals
    ) external onlyRoundOperator returns (uint256 roundId) {
        roundId = _startEqualSliceRound(asset, snapshotBlock, claimDeadline);
        _appendMemberRoots(roundId, memberTokens, memberRoots, manifestHashes, manifestURIs, memberApprovals);
    }

    /// @notice Lets a community reject its own proposed snapshot and leave the round.
    /// @dev Veto forfeits that community's equal slice back to pending so one admin cannot reset the
    ///      shared 24-hour review clock for every other community. The vetoed digest is blacklisted.
    function vetoMemberRoot(uint256 roundId, address memberToken) external {
        EqualSliceRound storage round = rounds[roundId];
        if (round.asset == address(0) || round.finalized || !roundIncludesMemberToken[roundId][memberToken]) {
            revert InvalidRound();
        }
        address roundRouter = routerForMemberAtRound(memberToken, roundId);
        if (msg.sender != IProjectRouter(roundRouter).projectAdmin()) revert InvalidSignature();

        bytes32 root = rootForMemberToken[roundId][memberToken];
        bytes32 manifestHash = manifestHashForMemberToken[roundId][memberToken];
        bytes32 manifestURIHash = keccak256(bytes(manifestURIForMemberToken[roundId][memberToken]));
        bytes32 digest = memberRootApprovalDigest(roundId, memberToken, root, manifestHash, manifestURIHash);
        vetoedRootDigest[digest] = true;

        _clearSubmittedRoot(roundId, memberToken);
        emit MemberRootVetoed(roundId, memberToken, msg.sender);
        _forfeitMemberFromRound(roundId, memberToken);
    }

    /// @notice Removes a round member that no longer meets fee-share / binding eligibility.
    /// @dev Prevents a drifted Doppler share from permanently blocking round finalization.
    function releaseIneligibleRoundMember(uint256 roundId, address memberToken) external {
        EqualSliceRound storage round = rounds[roundId];
        if (
            round.asset == address(0) || round.finalized || memberForfeitedForRound[roundId][memberToken]
                || !wasMemberForRound(memberToken, roundId)
        ) {
            revert InvalidRound();
        }
        address router = routerForMemberAtRound(memberToken, roundId);
        if (_isEligibleMemberRouter(router, memberToken)) revert StillEligible();

        if (roundIncludesMemberToken[roundId][memberToken]) {
            _clearSubmittedRoot(roundId, memberToken);
        }
        _forfeitMemberFromRound(roundId, memberToken);
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
        if (block.timestamp > round.claimDeadline || memberRoundClosed[roundId][memberToken]) {
            revert ClaimWindowClosed();
        }
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
        _cancelUnfinalizedRound(roundId);
    }

    /// @notice Lets anyone release a stale reserve after its claim deadline passes.
    function cancelExpiredUnfinalizedRound(uint256 roundId) external {
        EqualSliceRound memory round = rounds[roundId];
        if (round.asset == address(0) || round.finalized) revert InvalidRound();
        if (block.timestamp <= round.claimDeadline) revert ClaimWindowOpen();
        _cancelUnfinalizedRound(roundId);
    }

    function _cancelUnfinalizedRound(uint256 roundId) private {
        EqualSliceRound memory round = rounds[roundId];
        if (round.asset == address(0) || round.finalized) revert InvalidRound();

        address[] storage submitted = submittedMembersForRound[roundId];
        uint256 submittedCount = submitted.length;
        for (uint256 i; i < submittedCount; ++i) {
            address memberToken = submitted[i];
            delete roundIncludesMemberToken[roundId][memberToken];
            delete rootForMemberToken[roundId][memberToken];
            delete manifestHashForMemberToken[roundId][memberToken];
            delete manifestURIForMemberToken[roundId][memberToken];
        }
        while (submitted.length != 0) {
            submitted.pop();
        }

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

    function membershipWindowCount(address memberToken) external view returns (uint256) {
        return membershipWindows[memberToken].length;
    }

    function membershipWindowAt(address memberToken, uint256 index) external view returns (MembershipWindow memory) {
        return membershipWindows[memberToken][index];
    }

    function wasMemberForRound(address memberToken, uint256 roundId) public view returns (bool) {
        return routerForMemberAtRound(memberToken, roundId) != address(0);
    }

    function routerForMemberAtRound(address memberToken, uint256 roundId) public view returns (address) {
        MembershipWindow[] storage windows = membershipWindows[memberToken];
        uint256 length = windows.length;
        for (uint256 i = length; i != 0; --i) {
            MembershipWindow memory window = windows[i - 1];
            if (roundId >= window.startRound) {
                return window.endRoundExclusive == 0 || roundId < window.endRoundExclusive ? window.router : address(0);
            }
        }
        return address(0);
    }

    function memberRootApprovalDigest(
        uint256 roundId,
        address memberToken,
        bytes32 root,
        bytes32 manifestHash,
        bytes32 manifestURIHash
    ) public view returns (bytes32 digest) {
        EqualSliceRound memory round = rounds[roundId];
        if (round.asset == address(0)) revert InvalidRound();
        bytes32 structHash = keccak256(
            abi.encode(
                MEMBER_ROOT_APPROVAL_TYPEHASH,
                address(this),
                block.chainid,
                roundId,
                round.snapshotBlock,
                round.claimDeadline,
                memberToken,
                root,
                manifestHash,
                manifestURIHash,
                round.allocationPerCommunity
            )
        );
        bytes32 domainSeparator =
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _startEqualSliceRound(address asset, uint64 snapshotBlock, uint64 claimDeadline)
        private
        returns (uint256 roundId)
    {
        uint256 communityCount = activeMemberCount;
        if (!isApprovedAsset[asset] || communityCount == 0 || snapshotBlock >= block.number) revert InvalidRound();
        if (claimDeadline <= block.timestamp + ROOT_REVIEW_DELAY + MIN_POST_REVIEW_CLAIM_WINDOW) {
            revert InvalidRound();
        }
        if (claimDeadline > block.timestamp + MAX_CLAIM_WINDOW) revert ClaimWindowTooLong();

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
            rootReviewEndsAt: 0,
            finalized: false
        });

        emit EqualSliceRoundStarted(
            roundId, asset, snapshotBlock, claimDeadline, allocationPerCommunity, communityCount
        );
    }

    function _appendMemberRoots(
        uint256 roundId,
        address[] calldata memberTokens,
        bytes32[] calldata memberRoots,
        bytes32[] calldata manifestHashes,
        string[] calldata manifestURIs,
        bytes[] calldata memberApprovals
    ) private {
        EqualSliceRound storage round = rounds[roundId];
        uint256 rootCount = memberTokens.length;
        if (
            round.asset == address(0) || round.finalized || rootCount == 0 || memberRoots.length != rootCount
                || manifestHashes.length != rootCount || memberApprovals.length != rootCount
                || manifestURIs.length != rootCount || round.submittedCommunityCount + rootCount > round.communityCount
        ) revert InvalidRound();

        uint256 startIndex = round.submittedCommunityCount;
        bytes32 memberSetHash = round.memberSetHash;
        for (uint256 i; i < rootCount; ++i) {
            address memberToken = memberTokens[i];
            bytes32 memberRoot = memberRoots[i];
            bytes32 manifestHash = manifestHashes[i];
            string calldata manifestURI = manifestURIs[i];
            if (
                !wasMemberForRound(memberToken, roundId) || memberForfeitedForRound[roundId][memberToken]
                    || memberRoot == bytes32(0) || manifestHash == bytes32(0) || bytes(manifestURI).length == 0
                    || bytes(manifestURI).length > 256
            ) {
                revert InvalidRound();
            }
            if (roundIncludesMemberToken[roundId][memberToken]) revert DuplicateMemberToken();

            address roundRouter = routerForMemberAtRound(memberToken, roundId);
            if (!_isEligibleMemberRouter(roundRouter, memberToken)) revert InvalidRouter();

            bytes32 manifestURIHash = keccak256(bytes(manifestURI));
            bytes32 digest = memberRootApprovalDigest(roundId, memberToken, memberRoot, manifestHash, manifestURIHash);
            if (vetoedRootDigest[digest]) revert VetoedRoot();

            // Each community must affirmatively sign its own public snapshot commitment for the round.
            address projectAdmin = IProjectRouter(roundRouter).projectAdmin();
            if (!projectAdmin.isValidSignatureNow(digest, memberApprovals[i])) revert InvalidSignature();

            roundIncludesMemberToken[roundId][memberToken] = true;
            rootForMemberToken[roundId][memberToken] = memberRoot;
            manifestHashForMemberToken[roundId][memberToken] = manifestHash;
            manifestURIForMemberToken[roundId][memberToken] = manifestURI;
            submittedMembersForRound[roundId].push(memberToken);
            memberSetHash = keccak256(abi.encode(memberSetHash, memberToken, memberRoot, manifestHash, manifestURIHash));
            emit MemberRootPublished(roundId, memberToken, memberRoot, manifestHash, manifestURI);
        }

        round.submittedCommunityCount += rootCount;
        round.memberSetHash = memberSetHash;
        if (round.submittedCommunityCount == round.communityCount) {
            if (block.timestamp + ROOT_REVIEW_DELAY + MIN_POST_REVIEW_CLAIM_WINDOW > round.claimDeadline) {
                revert ClaimWindowClosed();
            }
            round.rootReviewEndsAt = uint64(block.timestamp + ROOT_REVIEW_DELAY);
        }
        emit MemberRootsAppended(roundId, startIndex, rootCount, round.rootReviewEndsAt);
    }

    function _finalizeEqualSliceRound(uint256 roundId) private {
        EqualSliceRound storage round = rounds[roundId];
        if (round.asset == address(0) || round.finalized || round.submittedCommunityCount != round.communityCount) {
            revert InvalidRound();
        }
        if (round.rootReviewEndsAt == 0 || block.timestamp < round.rootReviewEndsAt) revert RootReviewOpen();
        if (block.timestamp >= round.claimDeadline) revert ClaimWindowClosed();
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

    function _removeSubmittedMember(uint256 roundId, address memberToken) private {
        address[] storage submitted = submittedMembersForRound[roundId];
        uint256 length = submitted.length;
        for (uint256 i; i < length; ++i) {
            if (submitted[i] == memberToken) {
                submitted[i] = submitted[length - 1];
                submitted.pop();
                return;
            }
        }
        revert InvalidRound();
    }

    function _memberSetHashForRound(uint256 roundId) private view returns (bytes32 memberSetHash) {
        address[] storage submitted = submittedMembersForRound[roundId];
        uint256 length = submitted.length;
        for (uint256 i; i < length; ++i) {
            address memberToken = submitted[i];
            bytes32 manifestURIHash = keccak256(bytes(manifestURIForMemberToken[roundId][memberToken]));
            memberSetHash = keccak256(
                abi.encode(
                    memberSetHash,
                    memberToken,
                    rootForMemberToken[roundId][memberToken],
                    manifestHashForMemberToken[roundId][memberToken],
                    manifestURIHash
                )
            );
        }
    }

    function _validateMemberRouter(address router, address memberToken) private view {
        if (!_isEligibleMemberRouter(router, memberToken)) revert InvalidRouter();
    }

    function _isEligibleMemberRouter(address router, address memberToken) private view returns (bool) {
        if (router == address(0) || memberToken == address(0)) return false;
        IProjectRouter projectRouter = IProjectRouter(router);
        return projectRouter.hub() == address(this) && projectRouter.communityToken() == memberToken
            && projectRouter.poolBound() && isApprovedAsset[projectRouter.pairedAsset()]
            && isApprovedFeeManager[projectRouter.feeManager()]
            && isApprovedPoolBinding(
                projectRouter.feeManager(), projectRouter.dopplerPoolId(), memberToken, projectRouter.pairedAsset()
            )
            && IDopplerFeeManager(projectRouter.feeManager()).getShares(projectRouter.dopplerPoolId(), router)
                >= minimumRouterFeeShare;
    }

    function _requireSnapshotCommittee(address candidate) private view {
        if (candidate == address(0) || candidate.code.length == 0) revert InvalidSnapshotCommittee();
        address[] memory owners = ISafeCommittee(candidate).getOwners();
        uint256 threshold = ISafeCommittee(candidate).getThreshold();
        if (owners.length == 0 || threshold == 0 || threshold > owners.length) {
            revert InvalidSnapshotCommittee();
        }
    }

    function _clearSubmittedRoot(uint256 roundId, address memberToken) private {
        EqualSliceRound storage round = rounds[roundId];
        roundIncludesMemberToken[roundId][memberToken] = false;
        delete rootForMemberToken[roundId][memberToken];
        delete manifestHashForMemberToken[roundId][memberToken];
        delete manifestURIForMemberToken[roundId][memberToken];
        _removeSubmittedMember(roundId, memberToken);
        --round.submittedCommunityCount;
        round.memberSetHash = _memberSetHashForRound(roundId);
    }

    function _forfeitMemberFromRound(uint256 roundId, address memberToken) private {
        EqualSliceRound storage round = rounds[roundId];
        if (memberForfeitedForRound[roundId][memberToken]) revert InvalidRound();
        memberForfeitedForRound[roundId][memberToken] = true;

        uint256 returned = round.allocationPerCommunity;
        reservedRewards[round.asset] -= returned;
        pendingRewards[round.asset] += returned;
        --round.communityCount;

        emit MemberReleasedFromRound(roundId, memberToken, returned);

        if (round.communityCount == 0) {
            address asset = round.asset;
            delete rounds[roundId];
            address[] storage submitted = submittedMembersForRound[roundId];
            while (submitted.length != 0) {
                submitted.pop();
            }
            emit UnfinalizedRoundCancelled(roundId, asset, 0);
            return;
        }

        if (round.submittedCommunityCount == round.communityCount) {
            if (round.rootReviewEndsAt == 0) {
                if (block.timestamp + ROOT_REVIEW_DELAY + MIN_POST_REVIEW_CLAIM_WINDOW > round.claimDeadline) {
                    revert ClaimWindowClosed();
                }
                round.rootReviewEndsAt = uint64(block.timestamp + ROOT_REVIEW_DELAY);
            }
        } else {
            round.rootReviewEndsAt = 0;
        }
    }
}
