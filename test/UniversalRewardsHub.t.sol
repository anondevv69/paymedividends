// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDopplerFeeManager} from "../src/interfaces/IDopplerFeeManager.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {ISwapToSettlementAdapter} from "../src/interfaces/ISwapToSettlementAdapter.sol";
import {ProjectRouter} from "../src/ProjectRouter.sol";
import {ProjectRouterFactory} from "../src/ProjectRouterFactory.sol";
import {UniversalRewardsHub} from "../src/UniversalRewardsHub.sol";

interface VmV2 {
    function addr(uint256 privateKey) external returns (address);
    function expectRevert(bytes4) external;
    function prank(address) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

abstract contract TestV2 {
    VmV2 internal constant vm = VmV2(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "assertEq(uint256)");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "assertEq(address)");
    }

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue");
    }
}

contract MockTokenV2 is IERC20 {
    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_) {
        name = name_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        require(permitted >= amount, "allowance");
        allowance[from][msg.sender] = permitted - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract MockDopplerFeeManagerV2 is IDopplerFeeManager {
    MockTokenV2 internal immutable quote;
    MockTokenV2 internal immutable meme;
    mapping(bytes32 => mapping(address => uint256)) public shares;

    constructor(MockTokenV2 quote_, MockTokenV2 meme_) {
        quote = quote_;
        meme = meme_;
    }

    function setShares(bytes32 poolId, address beneficiary, uint256 value) external {
        shares[poolId][beneficiary] = value;
    }

    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return shares[poolId][beneficiary];
    }

    function collectFees(bytes32) external returns (uint256 amount0, uint256 amount1) {
        amount0 = quote.balanceOf(address(this));
        amount1 = meme.balanceOf(address(this));
        if (amount0 != 0) quote.transfer(msg.sender, amount0);
        if (amount1 != 0) meme.transfer(msg.sender, amount1);
    }

    function updateBeneficiary(bytes32 poolId, address newBeneficiary) external {
        uint256 share = shares[poolId][msg.sender];
        shares[poolId][msg.sender] = 0;
        shares[poolId][newBeneficiary] = share;
    }
}

contract MockSettlementAdapter is ISwapToSettlementAdapter {
    MockTokenV2 internal immutable output;

    constructor(MockTokenV2 output_) {
        output = output_;
    }

    function swapToSettlement(address tokenIn, address, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        MockTokenV2(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = amountIn;
        require(amountOut >= minAmountOut, "slippage");
        output.transfer(recipient, amountOut);
    }
}

contract MockERC1271ProjectAdmin {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;
    bytes32 public approvedDigest;

    function createRouter(ProjectRouterFactory factory, address hub) external returns (ProjectRouter router) {
        router = ProjectRouter(
            factory.createPrelaunchRouter(hub, ProjectRouter.MemeAssetPolicy.QuoteOnly, address(0), address(0))
        );
    }

    function approveDigest(bytes32 digest) external {
        approvedDigest = digest;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == approvedDigest ? MAGIC_VALUE : bytes4(0xffffffff);
    }
}

contract MockSafeCommittee {
    address[] private owners;
    uint256 private threshold;

    constructor(address owner1, address owner2, address owner3) {
        owners.push(owner1);
        owners.push(owner2);
        owners.push(owner3);
        threshold = 2;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

contract UniversalRewardsHubTest is TestV2 {
    uint256 internal constant PROJECT_A_KEY = 0xA11A;
    uint256 internal constant PROJECT_B_KEY = 0xB22B;
    address internal constant GOVERNANCE = address(0xA11CE);
    address internal constant OPS = address(0xFEE);
    address internal constant CONTRIBUTOR = address(0xC0FFEE);
    address internal constant HOLDER_A = address(0x1111);
    address internal constant HOLDER_B = address(0x2222);

    address internal projectA;
    address internal projectB;
    MockSafeCommittee internal snapshotCommittee;
    MockTokenV2 internal spy;
    MockTokenV2 internal nvda;
    MockTokenV2 internal memeA;
    MockTokenV2 internal memeB;
    MockDopplerFeeManagerV2 internal feeManagerA;
    MockDopplerFeeManagerV2 internal feeManagerB;
    UniversalRewardsHub internal hub;
    ProjectRouterFactory internal factory;
    ProjectRouter internal routerA;
    ProjectRouter internal routerB;
    bytes32 internal poolA = keccak256("pool-a");
    bytes32 internal poolB = keccak256("pool-b");

    function setUp() public {
        projectA = vm.addr(PROJECT_A_KEY);
        projectB = vm.addr(PROJECT_B_KEY);
        snapshotCommittee = new MockSafeCommittee(address(0x51), address(0x52), address(0x53));
        spy = new MockTokenV2("SPY");
        nvda = new MockTokenV2("NVDA");
        memeA = new MockTokenV2("MEMEA");
        memeB = new MockTokenV2("MEMEB");
        feeManagerA = new MockDopplerFeeManagerV2(spy, memeA);
        feeManagerB = new MockDopplerFeeManagerV2(spy, memeB);
        factory = new ProjectRouterFactory();
        hub = new UniversalRewardsHub(GOVERNANCE, OPS, address(snapshotCommittee), address(spy), address(factory), 500);

        vm.prank(GOVERNANCE);
        hub.setApprovedAsset(address(nvda), true);
        vm.prank(GOVERNANCE);
        hub.setApprovedFeeManager(address(feeManagerA), true);
        vm.prank(GOVERNANCE);
        hub.setApprovedFeeManager(address(feeManagerB), true);
        vm.prank(GOVERNANCE);
        hub.setApprovedPoolBinding(address(feeManagerA), poolA, address(memeA), address(spy), true);
        vm.prank(GOVERNANCE);
        hub.setApprovedPoolBinding(address(feeManagerB), poolB, address(memeB), address(spy), true);

        vm.prank(projectA);
        routerA = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.QuoteOnly, address(0), address(0))
        );
        vm.prank(projectB);
        routerB = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.QuoteOnly, address(0), address(0))
        );

        feeManagerA.setShares(poolA, address(routerA), 1e18);
        feeManagerB.setShares(poolB, address(routerB), 1e18);
        vm.prank(projectA);
        routerA.bindBankrDopplerLaunch(address(memeA), address(memeA), address(spy), address(feeManagerA), poolA);
        vm.prank(projectB);
        routerB.bindBankrDopplerLaunch(address(memeB), address(memeB), address(spy), address(feeManagerB), poolB);

        vm.prank(GOVERNANCE);
        hub.enrollMemberRouter(address(routerA), address(memeA));
        vm.prank(GOVERNANCE);
        hub.enrollMemberRouter(address(routerB), address(memeB));
        vm.warp(block.timestamp + hub.MEMBERSHIP_ACTIVATION_DELAY());
        hub.activateMemberRouter(address(memeA));
        hub.activateMemberRouter(address(memeB));
    }

    function test_equal_slice_round_requires_member_attestations_and_review_delay() public {
        _depositSpy(200e18);
        uint256 roundId = _startRound();
        (
            address[] memory members,
            bytes32[] memory roots,
            bytes32[] memory manifests,
            string[] memory manifestURIs,
            bytes[] memory approvals
        ) = _signedRoots(roundId, 95e18, 95e18);

        vm.prank(GOVERNANCE);
        hub.appendMemberRoots(roundId, members, roots, manifests, manifestURIs, approvals);
        vm.prank(GOVERNANCE);
        vm.expectRevert(UniversalRewardsHub.RootReviewOpen.selector);
        hub.finalizeEqualSliceRound(roundId);

        UniversalRewardsHub.EqualSliceRound memory round = hub.roundAt(roundId);
        vm.warp(round.rootReviewEndsAt);
        vm.prank(GOVERNANCE);
        hub.finalizeEqualSliceRound(roundId);

        bytes32[] memory noProof = new bytes32[](0);
        hub.claim(roundId, address(memeA), 0, HOLDER_A, 95e18, noProof);
        hub.claim(roundId, address(memeB), 0, HOLDER_B, 95e18, noProof);
        assertEq(spy.balanceOf(HOLDER_A), 95e18);
        assertEq(spy.balanceOf(HOLDER_B), 95e18);
    }

    function test_governance_cannot_invent_a_community_root() public {
        _depositSpy(200e18);
        uint256 roundId = _startRound();
        (
            address[] memory members,
            bytes32[] memory roots,
            bytes32[] memory manifests,
            string[] memory manifestURIs,
            bytes[] memory approvals
        ) = _signedRoots(roundId, 95e18, 95e18);
        bytes32 digest = hub.memberRootApprovalDigest(
            roundId, members[0], roots[0], manifests[0], keccak256(bytes(manifestURIs[0]))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        approvals[0] = abi.encodePacked(r, s, v);

        vm.prank(GOVERNANCE);
        vm.expectRevert(UniversalRewardsHub.InvalidSignature.selector);
        hub.appendMemberRoots(roundId, members, roots, manifests, manifestURIs, approvals);
    }

    function test_erc1271_project_admin_can_attest_a_community_root() public {
        MockERC1271ProjectAdmin smartAdmin = new MockERC1271ProjectAdmin();
        MockTokenV2 memeC = new MockTokenV2("MEMEC");
        MockDopplerFeeManagerV2 feeManagerC = new MockDopplerFeeManagerV2(spy, memeC);
        bytes32 poolC = keccak256("pool-c-1271");
        vm.prank(GOVERNANCE);
        hub.setApprovedFeeManager(address(feeManagerC), true);
        vm.prank(GOVERNANCE);
        hub.setApprovedPoolBinding(address(feeManagerC), poolC, address(memeC), address(spy), true);
        ProjectRouter routerC = smartAdmin.createRouter(factory, address(hub));
        feeManagerC.setShares(poolC, address(routerC), 1e18);
        vm.prank(address(smartAdmin));
        routerC.bindBankrDopplerLaunch(address(memeC), address(memeC), address(spy), address(feeManagerC), poolC);
        vm.prank(GOVERNANCE);
        hub.enrollMemberRouter(address(routerC), address(memeC));
        vm.warp(block.timestamp + hub.MEMBERSHIP_ACTIVATION_DELAY());
        hub.activateMemberRouter(address(memeC));

        _depositSpy(300e18);
        uint256 roundId = _startRound();
        address[] memory members = new address[](1);
        members[0] = address(memeC);
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = keccak256(abi.encodePacked(uint256(0), HOLDER_A, uint256(95e18)));
        bytes32[] memory manifests = new bytes32[](1);
        manifests[0] = keccak256("ipfs-smart-admin-manifest");
        string[] memory manifestURIs = new string[](1);
        manifestURIs[0] = "ipfs://smart-admin-manifest";
        bytes[] memory approvals = new bytes[](1);
        approvals[0] = hex"01";
        smartAdmin.approveDigest(
            hub.memberRootApprovalDigest(roundId, members[0], roots[0], manifests[0], keccak256(bytes(manifestURIs[0])))
        );

        vm.prank(GOVERNANCE);
        hub.appendMemberRoots(roundId, members, roots, manifests, manifestURIs, approvals);
        assertTrue(hub.roundIncludesMemberToken(roundId, address(memeC)));
    }

    function test_membership_is_frozen_when_round_starts() public {
        _depositSpy(200e18);
        uint256 roundId = _startRound();

        vm.prank(GOVERNANCE);
        hub.deactivateMemberRouter(address(memeA));
        assertTrue(hub.wasMemberForRound(address(memeA), roundId));

        (
            address[] memory members,
            bytes32[] memory roots,
            bytes32[] memory manifests,
            string[] memory manifestURIs,
            bytes[] memory approvals
        ) = _signedRoots(roundId, 95e18, 95e18);
        vm.prank(GOVERNANCE);
        hub.appendMemberRoots(roundId, members, roots, manifests, manifestURIs, approvals);
        assertEq(hub.roundAt(roundId).submittedCommunityCount, 2);
    }

    function test_project_admin_can_veto_its_root_during_review() public {
        _depositSpy(200e18);
        uint256 roundId = _startRound();
        (
            address[] memory members,
            bytes32[] memory roots,
            bytes32[] memory manifests,
            string[] memory manifestURIs,
            bytes[] memory approvals
        ) = _signedRoots(roundId, 95e18, 95e18);
        hub.appendMemberRoots(roundId, members, roots, manifests, manifestURIs, approvals);
        UniversalRewardsHub.EqualSliceRound memory beforeVeto = hub.roundAt(roundId);
        uint256 pendingBefore = hub.pendingRewards(address(spy));

        vm.prank(projectA);
        hub.vetoMemberRoot(roundId, address(memeA));
        assertTrue(!hub.roundIncludesMemberToken(roundId, address(memeA)));
        assertTrue(hub.memberForfeitedForRound(roundId, address(memeA)));
        assertEq(hub.roundAt(roundId).submittedCommunityCount, 1);
        assertEq(hub.roundAt(roundId).communityCount, 1);
        assertEq(hub.roundAt(roundId).rootReviewEndsAt, beforeVeto.rootReviewEndsAt);
        assertEq(hub.pendingRewards(address(spy)), pendingBefore + beforeVeto.allocationPerCommunity);

        bytes32 digest = hub.memberRootApprovalDigest(
            roundId, members[0], roots[0], manifests[0], keccak256(bytes(manifestURIs[0]))
        );
        assertTrue(hub.vetoedRootDigest(digest));

        address[] memory replayMembers = new address[](1);
        replayMembers[0] = members[0];
        bytes32[] memory replayRoots = new bytes32[](1);
        replayRoots[0] = roots[0];
        bytes32[] memory replayManifests = new bytes32[](1);
        replayManifests[0] = manifests[0];
        string[] memory replayURIs = new string[](1);
        replayURIs[0] = manifestURIs[0];
        bytes[] memory replayApprovals = new bytes[](1);
        replayApprovals[0] = approvals[0];
        vm.expectRevert(UniversalRewardsHub.InvalidRound.selector);
        hub.appendMemberRoots(roundId, replayMembers, replayRoots, replayManifests, replayURIs, replayApprovals);
    }

    function test_ineligible_member_can_be_released_from_a_round() public {
        _depositSpy(200e18);
        uint256 roundId = _startRound();
        feeManagerA.setShares(poolA, address(routerA), 0);
        uint256 pendingBefore = hub.pendingRewards(address(spy));

        hub.releaseIneligibleRoundMember(roundId, address(memeA));
        assertTrue(hub.memberForfeitedForRound(roundId, address(memeA)));
        assertEq(hub.roundAt(roundId).communityCount, 1);
        assertEq(hub.pendingRewards(address(spy)), pendingBefore + 95e18);
    }

    function test_snapshot_signer_must_be_a_safe_contract() public {
        vm.prank(GOVERNANCE);
        vm.expectRevert(UniversalRewardsHub.InvalidSnapshotCommittee.selector);
        hub.setSnapshotSigner(address(0xBEEF));
    }

    function test_claim_deadline_cannot_exceed_max_window() public {
        _depositSpy(200e18);
        vm.prank(GOVERNANCE);
        vm.expectRevert(UniversalRewardsHub.ClaimWindowTooLong.selector);
        hub.startEqualSliceRound(address(spy), uint64(block.number - 1), uint64(block.timestamp + 91 days));
    }

    function test_disabled_fee_manager_can_still_revoke_pool_binding() public {
        vm.prank(GOVERNANCE);
        hub.setApprovedFeeManager(address(feeManagerA), false);
        vm.prank(GOVERNANCE);
        hub.setApprovedPoolBinding(address(feeManagerA), poolA, address(memeA), address(spy), false);
        assertTrue(!hub.isApprovedPoolBinding(address(feeManagerA), poolA, address(memeA), address(spy)));
    }

    function test_new_member_cannot_activate_before_public_delay() public {
        MockTokenV2 memeC = new MockTokenV2("MEMEC");
        MockDopplerFeeManagerV2 feeManagerC = new MockDopplerFeeManagerV2(spy, memeC);
        bytes32 poolC = keccak256("pool-c-delay");
        vm.prank(GOVERNANCE);
        hub.setApprovedFeeManager(address(feeManagerC), true);
        vm.prank(GOVERNANCE);
        hub.setApprovedPoolBinding(address(feeManagerC), poolC, address(memeC), address(spy), true);
        vm.prank(projectA);
        ProjectRouter routerC = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.QuoteOnly, address(0), address(0))
        );
        feeManagerC.setShares(poolC, address(routerC), 1e18);
        vm.prank(projectA);
        routerC.bindBankrDopplerLaunch(address(memeC), address(memeC), address(spy), address(feeManagerC), poolC);
        vm.prank(GOVERNANCE);
        hub.enrollMemberRouter(address(routerC), address(memeC));

        vm.expectRevert(UniversalRewardsHub.ActivationPending.selector);
        hub.activateMemberRouter(address(memeC));
    }

    function test_activation_rechecks_revoked_pool_binding() public {
        MockTokenV2 memeC = new MockTokenV2("MEMEC");
        MockDopplerFeeManagerV2 feeManagerC = new MockDopplerFeeManagerV2(spy, memeC);
        bytes32 poolC = keccak256("pool-c-revoke");
        vm.prank(GOVERNANCE);
        hub.setApprovedFeeManager(address(feeManagerC), true);
        vm.prank(GOVERNANCE);
        hub.setApprovedPoolBinding(address(feeManagerC), poolC, address(memeC), address(spy), true);
        vm.prank(projectA);
        ProjectRouter routerC = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.QuoteOnly, address(0), address(0))
        );
        feeManagerC.setShares(poolC, address(routerC), 1e18);
        vm.prank(projectA);
        routerC.bindBankrDopplerLaunch(address(memeC), address(memeC), address(spy), address(feeManagerC), poolC);
        vm.prank(GOVERNANCE);
        hub.enrollMemberRouter(address(routerC), address(memeC));

        vm.prank(GOVERNANCE);
        hub.setApprovedPoolBinding(address(feeManagerC), poolC, address(memeC), address(spy), false);
        vm.warp(block.timestamp + hub.MEMBERSHIP_ACTIVATION_DELAY());
        vm.expectRevert(UniversalRewardsHub.InvalidRouter.selector);
        hub.activateMemberRouter(address(memeC));
    }

    function test_hub_enforces_each_community_maximum_even_with_an_attested_bad_root() public {
        _depositSpy(200e18);
        uint256 roundId = _startRound();
        (
            address[] memory members,
            bytes32[] memory roots,
            bytes32[] memory manifests,
            string[] memory manifestURIs,
            bytes[] memory approvals
        ) = _signedRoots(roundId, 96e18, 95e18);
        vm.prank(GOVERNANCE);
        hub.appendMemberRoots(roundId, members, roots, manifests, manifestURIs, approvals);
        UniversalRewardsHub.EqualSliceRound memory round = hub.roundAt(roundId);
        vm.warp(round.rootReviewEndsAt);
        vm.prank(GOVERNANCE);
        hub.finalizeEqualSliceRound(roundId);

        bytes32[] memory noProof = new bytes32[](0);
        vm.expectRevert(UniversalRewardsHub.ClaimExceedsCommunityAllocation.selector);
        hub.claim(roundId, address(memeA), 0, HOLDER_A, 96e18, noProof);
    }

    function test_router_collects_fee_manager_shape_and_routes_quote_to_hub() public {
        spy.mint(address(feeManagerA), 100e18);
        (uint256 pairedReceived, uint256 memeReceived, uint256 hubNet) = routerA.collectAndRouteBankrDopplerFees(0);

        assertEq(pairedReceived, 100e18);
        assertEq(memeReceived, 0);
        assertEq(hubNet, 95e18);
        assertEq(spy.balanceOf(OPS), 5e18);
        assertEq(hub.pendingRewards(address(spy)), 95e18);
    }

    function test_unsolicited_meme_cannot_block_quote_only_fee_collection() public {
        memeA.mint(address(routerA), 1);
        spy.mint(address(feeManagerA), 100e18);
        routerA.collectAndRouteBankrDopplerFees(0);

        assertEq(memeA.balanceOf(address(routerA)), 1);
        assertEq(hub.pendingRewards(address(spy)), 95e18);
    }

    function test_anyone_can_release_an_expired_unfinalized_round() public {
        _depositSpy(200e18);
        uint256 roundId = _startRound();
        UniversalRewardsHub.EqualSliceRound memory round = hub.roundAt(roundId);
        vm.warp(uint256(round.claimDeadline) + 1);
        hub.cancelExpiredUnfinalizedRound(roundId);

        assertEq(hub.pendingRewards(address(spy)), 190e18);
        assertEq(hub.reservedRewards(address(spy)), 0);
    }

    function testFuzz_deposit_charges_the_fixed_fee_once(uint96 rawAmount) public {
        uint256 amount = uint256(rawAmount) + 1;
        _depositSpy(amount);
        uint256 expectedFee = (amount * 500) / 10_000;
        assertEq(spy.balanceOf(OPS), expectedFee);
        assertEq(hub.pendingRewards(address(spy)), amount - expectedFee);
    }

    function test_router_forwards_an_approved_rwa_donation() public {
        nvda.mint(address(routerA), 100e18);
        uint256 netAmount = routerA.routeApprovedAsset(address(nvda));
        assertEq(netAmount, 95e18);
        assertEq(nvda.balanceOf(OPS), 5e18);
        assertEq(hub.pendingRewards(address(nvda)), 95e18);
    }

    function test_router_converts_meme_fee_through_fixed_adapter() public {
        MockSettlementAdapter adapter = new MockSettlementAdapter(spy);
        MockTokenV2 memeC = new MockTokenV2("MEMEC");
        MockDopplerFeeManagerV2 feeManagerC = new MockDopplerFeeManagerV2(spy, memeC);
        bytes32 poolC = keccak256("pool-c");
        vm.prank(GOVERNANCE);
        hub.setApprovedFeeManager(address(feeManagerC), true);
        vm.prank(GOVERNANCE);
        hub.setApprovedPoolBinding(address(feeManagerC), poolC, address(memeC), address(spy), true);
        vm.prank(projectA);
        ProjectRouter swapRouter = ProjectRouter(
            factory.createPrelaunchRouter(
                address(hub), ProjectRouter.MemeAssetPolicy.SwapToSettlement, address(0), address(adapter)
            )
        );
        feeManagerC.setShares(poolC, address(swapRouter), 1e18);
        vm.prank(projectA);
        swapRouter.bindBankrDopplerLaunch(address(memeC), address(memeC), address(spy), address(feeManagerC), poolC);

        memeC.mint(address(swapRouter), 100e18);
        spy.mint(address(adapter), 100e18);
        (uint256 settlementOut, uint256 hubNetAmount) = swapRouter.processMemeAsset(99e18);
        assertEq(settlementOut, 100e18);
        assertEq(hubNetAmount, 95e18);
    }

    function _depositSpy(uint256 amount) private {
        spy.mint(CONTRIBUTOR, amount);
        vm.prank(CONTRIBUTOR);
        spy.approve(address(hub), amount);
        vm.prank(CONTRIBUTOR);
        hub.deposit(address(spy), amount);
    }

    function _startRound() private returns (uint256 roundId) {
        vm.prank(GOVERNANCE);
        roundId = hub.startEqualSliceRound(address(spy), uint64(block.number - 1), uint64(block.timestamp + 30 days));
    }

    function _signedRoots(uint256 roundId, uint256 amountA, uint256 amountB)
        private
        returns (
            address[] memory members,
            bytes32[] memory roots,
            bytes32[] memory manifests,
            string[] memory manifestURIs,
            bytes[] memory approvals
        )
    {
        members = new address[](2);
        members[0] = address(memeA);
        members[1] = address(memeB);
        roots = new bytes32[](2);
        roots[0] = keccak256(abi.encodePacked(uint256(0), HOLDER_A, amountA));
        roots[1] = keccak256(abi.encodePacked(uint256(0), HOLDER_B, amountB));
        manifests = new bytes32[](2);
        manifests[0] = keccak256("ipfs-manifest-a");
        manifests[1] = keccak256("ipfs-manifest-b");
        manifestURIs = new string[](2);
        manifestURIs[0] = "ipfs://manifest-a";
        manifestURIs[1] = "ipfs://manifest-b";
        approvals = new bytes[](2);

        bytes32 digestA = hub.memberRootApprovalDigest(
            roundId, members[0], roots[0], manifests[0], keccak256(bytes(manifestURIs[0]))
        );
        (uint8 vA, bytes32 rA, bytes32 sA) = vm.sign(PROJECT_A_KEY, digestA);
        approvals[0] = abi.encodePacked(rA, sA, vA);
        bytes32 digestB = hub.memberRootApprovalDigest(
            roundId, members[1], roots[1], manifests[1], keccak256(bytes(manifestURIs[1]))
        );
        (uint8 vB, bytes32 rB, bytes32 sB) = vm.sign(PROJECT_B_KEY, digestB);
        approvals[1] = abi.encodePacked(rB, sB, vB);
    }
}
