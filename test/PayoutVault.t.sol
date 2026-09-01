// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PayoutVault} from "../src/PayoutVault.sol";
import {PayoutVaultFactory} from "../src/PayoutVaultFactory.sol";
import {IPayoutSwapAdapter} from "../src/interfaces/IPayoutSwapAdapter.sol";
import {IDopplerFeeManager} from "../src/interfaces/IDopplerFeeManager.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
}

abstract contract Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

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

contract MockERC20 {
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

contract MockSwapAdapter is IPayoutSwapAdapter {
    MockERC20 internal immutable output;
    uint256 internal immutable numerator;
    uint256 internal immutable denominator;

    constructor(MockERC20 output_, uint256 numerator_, uint256 denominator_) {
        output = output_;
        numerator = numerator_;
        denominator = denominator_;
    }

    function swap(address tokenIn, address, uint256 amountIn, uint256 minAmountOut, bytes calldata)
        external
        returns (uint256 amountOut)
    {
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * numerator) / denominator;
        require(amountOut >= minAmountOut, "slippage");
        output.transfer(msg.sender, amountOut);
    }
}

contract MockDopplerFeeManager is IDopplerFeeManager {
    MockERC20 internal immutable token0;
    MockERC20 internal immutable token1;

    constructor(MockERC20 token0_, MockERC20 token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function getShares(bytes32, address) external pure returns (uint256) {
        return 1e18;
    }

    function collectFees(bytes32) external returns (uint256 amount0, uint256 amount1) {
        amount0 = token0.balanceOf(address(this));
        amount1 = token1.balanceOf(address(this));
        if (amount0 != 0) token0.transfer(msg.sender, amount0);
        if (amount1 != 0) token1.transfer(msg.sender, amount1);
    }

    function updateBeneficiary(bytes32, address) external {}
}

contract PayoutVaultTest is Test {
    address internal constant PLATFORM_TREASURY = address(0xFEE);
    address internal constant KEEPER = address(0xBEEF);
    address internal constant CREATOR = address(0xCAFE);
    address internal constant HOLDER_A = address(0xA11CE);
    address internal constant HOLDER_B = address(0xB0B);

    MockERC20 internal testToken;
    MockERC20 internal nvda;
    MockSwapAdapter internal adapter;
    PayoutVaultFactory internal factory;
    PayoutVault internal vault;

    function setUp() public {
        testToken = new MockERC20("TEST");
        nvda = new MockERC20("NVDA");
        adapter = new MockSwapAdapter(nvda, 2, 1);
        nvda.mint(address(adapter), 1_000e18);

        factory = new PayoutVaultFactory(PLATFORM_TREASURY, KEEPER, 500);
        vm.prank(CREATOR);
        address created =
            factory.createProject(address(testToken), address(testToken), address(nvda), address(adapter), 1e18);
        vault = PayoutVault(created);
    }

    function test_creates_isolated_vault_with_immutable_platform_policy() public view {
        assertTrue(factory.isProjectVault(address(vault)));
        assertEq(vault.creator(), CREATOR);
        assertEq(vault.platformTreasury(), PLATFORM_TREASURY);
        assertEq(vault.platformFeeBps(), 500);
        assertEq(vault.payoutAsset(), address(nvda));
    }

    function test_legacy_implementation_cannot_be_initialized() public {
        PayoutVault implementation = PayoutVault(factory.implementation());
        vm.expectRevert(PayoutVault.AlreadyInitialized.selector);
        implementation.initialize(
            CREATOR,
            KEEPER,
            address(testToken),
            address(testToken),
            address(nvda),
            address(adapter),
            PLATFORM_TREASURY,
            500,
            1e18
        );
    }

    function test_swap_then_settle_takes_five_percent_in_payout_asset() public {
        testToken.mint(address(vault), 100e18);

        vm.prank(KEEPER);
        (uint256 gross, uint256 fee, uint256 holderAmount) = vault.swapAndSettle(100e18, 200e18, "");

        assertEq(gross, 200e18);
        assertEq(fee, 10e18);
        assertEq(holderAmount, 190e18);
        assertEq(nvda.balanceOf(PLATFORM_TREASURY), 10e18);
        assertEq(vault.unallocatedPayout(), 190e18);
        assertEq(vault.reservedForClaims(), 0);
    }

    function test_reserved_holder_funds_cannot_be_settled_as_new_revenue() public {
        nvda.mint(address(vault), 200e18);
        vm.prank(KEEPER);
        vault.settlePayoutRevenue();

        bytes32 leafA = _leaf(1, HOLDER_A, 100e18);
        bytes32 leafB = _leaf(1, HOLDER_B, 90e18);
        vm.prank(KEEPER);
        vault.openRound(uint64(block.number - 1), _pair(leafA, leafB), 2, 190e18);

        vm.prank(KEEPER);
        vm.expectRevert(PayoutVault.NothingToSettle.selector);
        vault.settlePayoutRevenue();

        assertEq(vault.reservedForClaims(), 190e18);
        assertEq(nvda.balanceOf(PLATFORM_TREASURY), 10e18);
    }

    function test_holders_claim_from_a_reserved_round() public {
        nvda.mint(address(vault), 200e18);
        vm.prank(KEEPER);
        vault.settlePayoutRevenue();

        bytes32 leafA = _leaf(1, HOLDER_A, 100e18);
        bytes32 leafB = _leaf(1, HOLDER_B, 90e18);
        vm.prank(KEEPER);
        vault.openRound(uint64(block.number - 1), _pair(leafA, leafB), 2, 190e18);

        vm.prank(HOLDER_A);
        vault.claim(1, 100e18, _proof(leafB));
        vm.prank(HOLDER_B);
        vault.claim(1, 90e18, _proof(leafA));

        assertEq(nvda.balanceOf(HOLDER_A), 100e18);
        assertEq(nvda.balanceOf(HOLDER_B), 90e18);
        assertEq(vault.reservedForClaims(), 0);
    }

    function test_only_keeper_can_settle_or_open_a_round() public {
        nvda.mint(address(vault), 200e18);
        vm.prank(CREATOR);
        vm.expectRevert(PayoutVault.NotKeeper.selector);
        vault.settlePayoutRevenue();

        vm.prank(KEEPER);
        vault.settlePayoutRevenue();
        vm.prank(CREATOR);
        vm.expectRevert(PayoutVault.NotKeeper.selector);
        vault.openRound(uint64(block.number - 1), bytes32(uint256(1)), 1, 190e18);
    }

    function test_creator_can_pause_future_rounds_but_not_holder_claims() public {
        nvda.mint(address(vault), 200e18);
        vm.prank(KEEPER);
        vault.settlePayoutRevenue();

        bytes32 leaf = _leaf(1, HOLDER_A, 190e18);
        vm.prank(KEEPER);
        vault.openRound(uint64(block.number - 1), leaf, 1, 190e18);

        vm.prank(CREATOR);
        vault.setPaused(true);

        vm.prank(HOLDER_A);
        vault.claim(1, 190e18, new bytes32[](0));
        assertEq(nvda.balanceOf(HOLDER_A), 190e18);
    }

    function test_prelaunch_bankr_doppler_vault_claims_then_splits_payout_asset() public {
        MockDopplerFeeManager feeManager = new MockDopplerFeeManager(testToken, nvda);
        bytes32 poolId = bytes32(uint256(123));

        vm.prank(CREATOR);
        address prelaunchAddress = factory.createPrelaunchBankrDopplerProject(address(nvda), 1e18);
        PayoutVault prelaunchVault = PayoutVault(prelaunchAddress);

        assertTrue(!prelaunchVault.launchBound());
        vm.prank(KEEPER);
        vm.expectRevert(PayoutVault.LaunchNotBound.selector);
        prelaunchVault.settlePayoutRevenue();

        vm.prank(CREATOR);
        prelaunchVault.bindBankrDopplerLaunch(
            address(testToken), address(testToken), address(adapter), address(feeManager), poolId
        );
        assertTrue(prelaunchVault.launchBound());
        assertEq(prelaunchVault.holderToken(), address(testToken));

        vm.prank(CREATOR);
        vm.expectRevert(PayoutVault.LaunchAlreadyBound.selector);
        prelaunchVault.bindBankrDopplerLaunch(
            address(testToken), address(testToken), address(adapter), address(feeManager), poolId
        );

        testToken.mint(address(feeManager), 40e18);
        nvda.mint(address(feeManager), 200e18);
        vm.prank(KEEPER);
        (uint256 payoutReceived, uint256 sourceReceived, uint256 platformFee, uint256 holderAmount) =
            prelaunchVault.claimBankrDopplerFees();

        assertEq(payoutReceived, 200e18);
        assertEq(sourceReceived, 40e18);
        assertEq(platformFee, 10e18);
        assertEq(holderAmount, 190e18);
        assertEq(nvda.balanceOf(PLATFORM_TREASURY), 10e18);
        assertEq(prelaunchVault.unallocatedPayout(), 190e18);
        assertEq(testToken.balanceOf(address(prelaunchVault)), 40e18);
    }

    function _leaf(uint256 roundId, address account, uint256 amount) private pure returns (bytes32) {
        return keccak256(abi.encode(roundId, account, amount));
    }

    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _proof(bytes32 sibling) private pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }
}
