// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../src/interfaces/IERC20.sol";
import {ISwapToSettlementAdapter} from "../src/interfaces/ISwapToSettlementAdapter.sol";
import {ProjectRouter} from "../src/ProjectRouter.sol";
import {ProjectRouterFactory} from "../src/ProjectRouterFactory.sol";
import {UniversalRewardsHub} from "../src/UniversalRewardsHub.sol";

interface VmV2 {
    function prank(address) external;
    function expectRevert(bytes4) external;
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

contract MockSettlementAdapter is ISwapToSettlementAdapter {
    MockTokenV2 internal immutable output;
    uint256 internal immutable numerator;
    uint256 internal immutable denominator;

    constructor(MockTokenV2 output_, uint256 numerator_, uint256 denominator_) {
        output = output_;
        numerator = numerator_;
        denominator = denominator_;
    }

    function swapToSettlement(address tokenIn, address, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        MockTokenV2(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * numerator) / denominator;
        require(amountOut >= minAmountOut, "slippage");
        output.transfer(recipient, amountOut);
    }
}

contract UniversalRewardsHubTest is TestV2 {
    address internal constant GOVERNANCE = address(0xA11CE);
    address internal constant OPS = address(0xFEE);
    address internal constant PROJECT_A = address(0xAAA1);
    address internal constant PROJECT_B = address(0xBBB2);
    address internal constant CONTRIBUTOR = address(0xC0FFEE);
    address internal constant HOLDER_A = address(0x1111);
    address internal constant HOLDER_B = address(0x2222);

    MockTokenV2 internal spy;
    MockTokenV2 internal nvda;
    MockTokenV2 internal memeA;
    MockTokenV2 internal memeB;
    UniversalRewardsHub internal hub;
    ProjectRouterFactory internal factory;
    ProjectRouter internal routerA;
    ProjectRouter internal routerB;

    function setUp() public {
        spy = new MockTokenV2("SPY");
        nvda = new MockTokenV2("NVDA");
        memeA = new MockTokenV2("MEMEA");
        memeB = new MockTokenV2("MEMEB");
        hub = new UniversalRewardsHub(GOVERNANCE, OPS, address(spy), 500);
        factory = new ProjectRouterFactory();

        vm.prank(GOVERNANCE);
        hub.setApprovedAsset(address(nvda), true);

        vm.prank(PROJECT_A);
        routerA = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.QuoteOnly, address(0), address(0))
        );
        vm.prank(PROJECT_B);
        routerB = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.QuoteOnly, address(0), address(0))
        );

        vm.prank(PROJECT_A);
        routerA.bindBankrDopplerLaunch(address(memeA), address(memeA), keccak256("pool-a"));
        vm.prank(PROJECT_B);
        routerB.bindBankrDopplerLaunch(address(memeB), address(memeB), keccak256("pool-b"));

        vm.prank(GOVERNANCE);
        hub.enrollMemberRouter(address(routerA), address(memeA));
        vm.prank(GOVERNANCE);
        hub.enrollMemberRouter(address(routerB), address(memeB));
    }

    function test_hub_takes_fee_then_reserves_equal_slice_for_every_member_community() public {
        spy.mint(CONTRIBUTOR, 200e18);
        vm.prank(CONTRIBUTOR);
        spy.approve(address(hub), 200e18);
        vm.prank(CONTRIBUTOR);
        uint256 netAmount = hub.deposit(address(spy), 200e18);

        assertEq(netAmount, 190e18);
        assertEq(spy.balanceOf(OPS), 10e18);
        assertEq(hub.pendingRewards(address(spy)), 190e18);

        address[] memory memberTokens = new address[](2);
        memberTokens[0] = address(memeA);
        memberTokens[1] = address(memeB);
        bytes32[] memory roots = new bytes32[](2);
        roots[0] = keccak256(abi.encodePacked(uint256(0), HOLDER_A, uint256(95e18)));
        roots[1] = keccak256(abi.encodePacked(uint256(0), HOLDER_B, uint256(95e18)));

        vm.prank(GOVERNANCE);
        uint256 roundId = hub.createEqualSliceRound(
            address(spy), uint64(block.number - 1), uint64(block.timestamp + 30 days), memberTokens, roots
        );

        UniversalRewardsHub.EqualSliceRound memory round = hub.roundAt(roundId);
        assertEq(round.allocationPerCommunity, 95e18);
        assertEq(round.communityCount, 2);
        assertEq(hub.pendingRewards(address(spy)), 0);
        assertEq(hub.reservedRewards(address(spy)), 190e18);

        bytes32[] memory noProof = new bytes32[](0);
        hub.claim(roundId, address(memeA), 0, HOLDER_A, 95e18, noProof);
        hub.claim(roundId, address(memeB), 0, HOLDER_B, 95e18, noProof);

        assertEq(spy.balanceOf(HOLDER_A), 95e18);
        assertEq(spy.balanceOf(HOLDER_B), 95e18);
        assertEq(hub.reservedRewards(address(spy)), 0);
    }

    function test_hub_enforces_each_community_maximum_even_when_a_root_is_bad() public {
        spy.mint(CONTRIBUTOR, 200e18);
        vm.prank(CONTRIBUTOR);
        spy.approve(address(hub), 200e18);
        vm.prank(CONTRIBUTOR);
        hub.deposit(address(spy), 200e18);

        address[] memory memberTokens = new address[](2);
        memberTokens[0] = address(memeA);
        memberTokens[1] = address(memeB);
        bytes32[] memory roots = new bytes32[](2);
        roots[0] = keccak256(abi.encodePacked(uint256(0), HOLDER_A, uint256(96e18)));
        roots[1] = keccak256(abi.encodePacked(uint256(0), HOLDER_B, uint256(95e18)));

        vm.prank(GOVERNANCE);
        uint256 roundId = hub.createEqualSliceRound(
            address(spy), uint64(block.number - 1), uint64(block.timestamp + 30 days), memberTokens, roots
        );

        bytes32[] memory noProof = new bytes32[](0);
        vm.expectRevert(UniversalRewardsHub.ClaimExceedsCommunityAllocation.selector);
        hub.claim(roundId, address(memeA), 0, HOLDER_A, 96e18, noProof);
    }

    function test_large_member_sets_can_append_roots_in_batches_before_finalizing() public {
        spy.mint(CONTRIBUTOR, 200e18);
        vm.prank(CONTRIBUTOR);
        spy.approve(address(hub), 200e18);
        vm.prank(CONTRIBUTOR);
        hub.deposit(address(spy), 200e18);

        vm.prank(GOVERNANCE);
        uint256 roundId = hub.startEqualSliceRound(address(spy), uint64(block.number - 1), uint64(block.timestamp + 30 days));

        address[] memory firstMember = new address[](1);
        firstMember[0] = address(memeA);
        bytes32[] memory firstRoot = new bytes32[](1);
        firstRoot[0] = keccak256(abi.encodePacked(uint256(0), HOLDER_A, uint256(95e18)));
        vm.prank(GOVERNANCE);
        hub.appendMemberRoots(roundId, firstMember, firstRoot);

        bytes32[] memory noProof = new bytes32[](0);
        vm.expectRevert(UniversalRewardsHub.InvalidRound.selector);
        hub.claim(roundId, address(memeA), 0, HOLDER_A, 95e18, noProof);

        address[] memory secondMember = new address[](1);
        secondMember[0] = address(memeB);
        bytes32[] memory secondRoot = new bytes32[](1);
        secondRoot[0] = keccak256(abi.encodePacked(uint256(0), HOLDER_B, uint256(95e18)));
        vm.prank(GOVERNANCE);
        hub.appendMemberRoots(roundId, secondMember, secondRoot);
        vm.prank(GOVERNANCE);
        hub.finalizeEqualSliceRound(roundId);

        UniversalRewardsHub.EqualSliceRound memory round = hub.roundAt(roundId);
        assertTrue(round.finalized);
        assertEq(round.submittedCommunityCount, 2);

        hub.claim(roundId, address(memeA), 0, HOLDER_A, 95e18, noProof);
        assertEq(spy.balanceOf(HOLDER_A), 95e18);
    }

    function test_router_forwards_approved_rwa_to_its_own_hub_bucket() public {
        nvda.mint(address(routerA), 100e18);
        uint256 netAmount = routerA.routeApprovedAsset(address(nvda));

        assertEq(netAmount, 95e18);
        assertEq(nvda.balanceOf(OPS), 5e18);
        assertEq(hub.pendingRewards(address(nvda)), 95e18);
        assertEq(nvda.balanceOf(address(routerA)), 0);
    }

    function test_governance_can_replace_a_member_router_without_breaking_past_claims() public {
        vm.prank(GOVERNANCE);
        hub.deactivateMemberRouter(address(memeA));
        assertEq(hub.activeMemberCount(), 1);

        vm.prank(PROJECT_A);
        ProjectRouter replacementRouter = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.Burn, address(0), address(0))
        );
        vm.prank(PROJECT_A);
        replacementRouter.bindBankrDopplerLaunch(address(memeA), address(memeA), keccak256("replacement-pool-a"));
        vm.prank(GOVERNANCE);
        hub.enrollMemberRouter(address(replacementRouter), address(memeA));

        assertEq(hub.activeMemberCount(), 2);
        assertEq(hub.routerForMemberToken(address(memeA)), address(replacementRouter));
    }

    function test_router_converts_its_meme_fee_to_spy_then_routes_it_to_hub() public {
        MockSettlementAdapter adapter = new MockSettlementAdapter(spy, 1, 1);
        vm.prank(PROJECT_A);
        ProjectRouter swapRouter = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.SwapToSettlement, address(0), address(adapter))
        );
        MockTokenV2 memeC = new MockTokenV2("MEMEC");
        vm.prank(PROJECT_A);
        swapRouter.bindBankrDopplerLaunch(address(memeC), address(memeC), keccak256("pool-c"));

        memeC.mint(address(swapRouter), 100e18);
        spy.mint(address(adapter), 100e18);
        (uint256 settlementOut, uint256 hubNetAmount) = swapRouter.processMemeAsset(99e18);

        assertEq(settlementOut, 100e18);
        assertEq(hubNetAmount, 95e18);
        assertEq(memeC.balanceOf(address(swapRouter)), 0);
        assertEq(spy.balanceOf(OPS), 5e18);
        assertEq(hub.pendingRewards(address(spy)), 95e18);
    }
}
