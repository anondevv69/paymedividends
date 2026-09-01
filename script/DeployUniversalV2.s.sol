// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ProjectRouterFactory} from "../src/ProjectRouterFactory.sol";
import {UniversalRewardsHub} from "../src/UniversalRewardsHub.sol";

interface VmDeploy {
    function envAddress(string calldata name) external returns (address value);
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Foundry deployment entrypoint for the v2 tokenless Hub and Project Router Factory.
/// @dev Run this on Robinhood Chain testnet first. It deploys no swap adapter and enrolls no member
///      router; those actions require a separately verified Bankr/Doppler pool after deployment.
contract DeployUniversalV2 {
    VmDeploy internal constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (UniversalRewardsHub hub, ProjectRouterFactory routerFactory) {
        address governanceSafe = vm.envAddress("GOVERNANCE_SAFE");
        address opsSafe = vm.envAddress("OPS_SAFE");
        address settlementAsset = vm.envAddress("SETTLEMENT_ASSET");
        uint256 feeBps = vm.envUint("HUB_FEE_BPS");
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        hub = new UniversalRewardsHub(governanceSafe, opsSafe, settlementAsset, feeBps);
        routerFactory = new ProjectRouterFactory();
        vm.stopBroadcast();
    }
}
