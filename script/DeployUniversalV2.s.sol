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

interface ISafeLike {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function masterCopy() external view returns (address);
}

/// @notice Foundry deployment entrypoint for the v2 tokenless Hub and Project Router Factory.
/// @dev Run this on Robinhood Chain testnet first. It deploys no swap adapter and enrolls no member
///      router; those actions require a separately verified Bankr/Doppler pool after deployment.
contract DeployUniversalV2 {
    VmDeploy internal constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    address internal constant ROBINHOOD_SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant SAFE_L2_SINGLETON_V150 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e;
    address internal constant SAFE_L2_SINGLETON_V141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;

    error WrongChain();
    error InvalidSafe();
    error InvalidSettlementAsset();

    function run() external returns (UniversalRewardsHub hub, ProjectRouterFactory routerFactory) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();
        address governanceSafe = vm.envAddress("GOVERNANCE_SAFE");
        address opsSafe = vm.envAddress("OPS_SAFE");
        address snapshotCommitteeSafe = vm.envAddress("SNAPSHOT_SIGNER");
        uint256 feeBps = vm.envUint("HUB_FEE_BPS");
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        _validateSafe(governanceSafe);
        _validateSafe(opsSafe);
        _validateSafe(snapshotCommitteeSafe);
        if (ROBINHOOD_SPY.code.length == 0) revert InvalidSettlementAsset();

        vm.startBroadcast(deployerPrivateKey);
        routerFactory = new ProjectRouterFactory();
        hub = new UniversalRewardsHub(
            governanceSafe, opsSafe, snapshotCommitteeSafe, ROBINHOOD_SPY, address(routerFactory), feeBps
        );
        vm.stopBroadcast();
    }

    /// @dev Accepts a Robinhood Safe with at least one owner. v1 may use a single 1-of-1 Safe for
    ///      governance, ops, and round operator.
    function _validateSafe(address candidate) private view {
        if (candidate.code.length == 0) revert InvalidSafe();
        try ISafeLike(candidate).masterCopy() returns (address singleton) {
            if (singleton != SAFE_L2_SINGLETON_V150 && singleton != SAFE_L2_SINGLETON_V141) revert InvalidSafe();
        } catch {
            revert InvalidSafe();
        }
        try ISafeLike(candidate).getOwners() returns (address[] memory owners) {
            if (owners.length == 0) revert InvalidSafe();
            try ISafeLike(candidate).getThreshold() returns (uint256 threshold) {
                if (threshold == 0 || threshold > owners.length) revert InvalidSafe();
            } catch {
                revert InvalidSafe();
            }
        } catch {
            revert InvalidSafe();
        }
    }
}
