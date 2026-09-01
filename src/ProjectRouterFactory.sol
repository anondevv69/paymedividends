// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "./libraries/Clones.sol";
import {ProjectRouter} from "./ProjectRouter.sol";

/// @title ProjectRouterFactory
/// @notice Permissionless creator of isolated pre-launch Bankr/Doppler Project Routers.
/// @dev A router becomes a shared-Hub member only after governance verifies and enrolls its bound launch.
contract ProjectRouterFactory {
    using Clones for address;

    address public immutable implementation;
    mapping(address => bool) public isProjectRouter;
    address[] private projectRouters;

    event PrelaunchRouterCreated(
        address indexed projectAdmin,
        address indexed router,
        address indexed hub,
        ProjectRouter.MemeAssetPolicy memeAssetPolicy,
        address memeLockbox,
        address swapAdapter
    );

    error ZeroAddress();

    constructor() {
        implementation = address(new ProjectRouter());
    }

    function createPrelaunchRouter(
        address hub,
        ProjectRouter.MemeAssetPolicy memeAssetPolicy,
        address memeLockbox,
        address swapAdapter
    ) external returns (address router) {
        if (hub == address(0)) revert ZeroAddress();

        router = implementation.clone();
        ProjectRouter(router).initialize(msg.sender, hub, memeAssetPolicy, memeLockbox, swapAdapter);
        isProjectRouter[router] = true;
        projectRouters.push(router);

        emit PrelaunchRouterCreated(msg.sender, router, hub, memeAssetPolicy, memeLockbox, swapAdapter);
    }

    function routerCount() external view returns (uint256) {
        return projectRouters.length;
    }

    function routerAt(uint256 index) external view returns (address) {
        return projectRouters[index];
    }
}
