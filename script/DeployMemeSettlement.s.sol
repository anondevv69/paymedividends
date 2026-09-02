// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MemeToSettlementAdapter} from "../src/MemeToSettlementAdapter.sol";
import {RobinhoodMemeSwapExecutor} from "../src/RobinhoodMemeSwapExecutor.sol";

interface VmDeploy {
    function envAddress(string calldata name) external returns (address value);
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deploy meme → paired RWA settlement infrastructure alongside the Hub.
contract DeployMemeSettlement {
    VmDeploy internal constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    error WrongChain();

    function run() external returns (MemeToSettlementAdapter adapter, RobinhoodMemeSwapExecutor executor) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();
        address hub = vm.envAddress("UNIVERSAL_REWARDS_HUB");
        address governance = vm.envAddress("GOVERNANCE_SAFE");
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        executor = new RobinhoodMemeSwapExecutor(hub, governance);
        adapter = new MemeToSettlementAdapter(hub, address(executor));
        vm.stopBroadcast();
    }
}
