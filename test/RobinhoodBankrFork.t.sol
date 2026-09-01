// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDopplerFeeManager} from "../src/interfaces/IDopplerFeeManager.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {ProjectRouter} from "../src/ProjectRouter.sol";
import {ProjectRouterFactory} from "../src/ProjectRouterFactory.sol";
import {UniversalRewardsHub} from "../src/UniversalRewardsHub.sol";

interface VmRobinhoodFork {
    function createSelectFork(string calldata urlOrAlias) external returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function prank(address sender) external;
    function skip(bool skipTest) external;
}

/// @notice Read-only fork validation against the live Bankr DEVS/MSFT Doppler pool.
/// @dev Set ROBINHOOD_ARCHIVE_RPC_URL to execute this test. It never broadcasts a transaction.
contract RobinhoodBankrForkTest {
    VmRobinhoodFork private constant vm = VmRobinhoodFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant DEVS = 0x80Db362eAB104Ec378E19D0a3dCD5E84Bafd4bA3;
    address private constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address private constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address private constant BENEFICIARY = 0x374D91a5674Fa7Cf86E725093b5848b97e1e13b4;
    address private constant FEE_MANAGER = 0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544;
    bytes32 private constant POOL_ID = 0x130caf8b43343e182a79a4046932bd5623a87e9309e7c53e2d1efb4ec6b8e2a0;

    function test_live_devs_pool_routes_through_a_new_hub_and_router() public {
        string memory rpcUrl = vm.envOr("ROBINHOOD_ARCHIVE_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return;
        }

        vm.createSelectFork(rpcUrl);
        require(block.chainid == 4663, "wrong chain");
        require(FEE_MANAGER.code.length != 0, "missing fee manager");
        require(DEVS.code.length != 0 && MSFT.code.length != 0, "missing pair assets");
        require(IDopplerFeeManager(FEE_MANAGER).getShares(POOL_ID, BENEFICIARY) == 0.95e18, "wrong share");

        ForkSafeCommittee committee = new ForkSafeCommittee(address(0x51), address(0x52), address(0x53));
        ProjectRouterFactory factory = new ProjectRouterFactory();
        UniversalRewardsHub hub =
            new UniversalRewardsHub(address(this), address(0xFEE), address(committee), SPY, address(factory), 500);
        hub.setApprovedAsset(MSFT, true);
        hub.setApprovedFeeManager(FEE_MANAGER, true);
        hub.setApprovedPoolBinding(FEE_MANAGER, POOL_ID, DEVS, MSFT, true);
        ProjectRouter router = ProjectRouter(
            factory.createPrelaunchRouter(address(hub), ProjectRouter.MemeAssetPolicy.QuoteOnly, address(0), address(0))
        );

        vm.prank(BENEFICIARY);
        IDopplerFeeManager(FEE_MANAGER).updateBeneficiary(POOL_ID, address(router));
        require(
            IDopplerFeeManager(FEE_MANAGER).getShares(POOL_ID, address(router)) >= hub.minimumRouterFeeShare(),
            "beneficiary not updated"
        );
        router.bindBankrDopplerLaunch(DEVS, DEVS, MSFT, FEE_MANAGER, POOL_ID);

        uint256 hubBefore = IERC20(MSFT).balanceOf(address(hub));
        router.collectAndRouteBankrDopplerFees(0);
        require(IERC20(MSFT).balanceOf(address(hub)) > hubBefore, "no MSFT routed through hub");
    }
}

contract ForkSafeCommittee {
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
}
