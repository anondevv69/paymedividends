// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "./libraries/Clones.sol";
import {PayoutVault} from "./PayoutVault.sol";

/// @title PayoutVaultFactory
/// @notice Creates an isolated EIP-1167 PayoutVault for each token project.
/// @dev Platform fee policy is immutable for this factory and copied into every project created by it.
contract PayoutVaultFactory {
    using Clones for address;

    uint16 private constant MAX_PLATFORM_FEE_BPS = 1_000;

    address public immutable implementation;
    address public immutable platformTreasury;
    address public immutable platformKeeper;
    uint16 public immutable platformFeeBps;

    mapping(address => bool) public isProjectVault;
    address[] private projectVaults;

    event ProjectCreated(
        address indexed creator,
        address indexed vault,
        address indexed holderToken,
        address sourceAsset,
        address payoutAsset,
        address swapAdapter,
        uint256 minimumRoundPayout
    );

    error ZeroAddress();
    error InvalidFee();
    error InvalidConfiguration();

    constructor(address platformTreasury_, address platformKeeper_, uint16 platformFeeBps_) {
        if (platformTreasury_ == address(0) || platformKeeper_ == address(0)) revert ZeroAddress();
        if (platformFeeBps_ > MAX_PLATFORM_FEE_BPS) revert InvalidFee();
        platformTreasury = platformTreasury_;
        platformKeeper = platformKeeper_;
        platformFeeBps = platformFeeBps_;
        implementation = address(new PayoutVault());
    }

    function createProject(
        address holderToken,
        address sourceAsset,
        address payoutAsset,
        address swapAdapter,
        uint256 minimumRoundPayout
    ) external returns (address vault) {
        if (holderToken == address(0) || sourceAsset == address(0) || payoutAsset == address(0)) {
            revert ZeroAddress();
        }
        if (sourceAsset == payoutAsset && swapAdapter != address(0)) revert InvalidConfiguration();
        if (sourceAsset != payoutAsset && swapAdapter == address(0)) revert InvalidConfiguration();

        vault = implementation.clone();
        PayoutVault(vault)
            .initialize(
                msg.sender,
                platformKeeper,
                holderToken,
                sourceAsset,
                payoutAsset,
                swapAdapter,
                platformTreasury,
                platformFeeBps,
                minimumRoundPayout
            );
        isProjectVault[vault] = true;
        projectVaults.push(vault);

        emit ProjectCreated(msg.sender, vault, holderToken, sourceAsset, payoutAsset, swapAdapter, minimumRoundPayout);
    }

    function projectCount() external view returns (uint256) {
        return projectVaults.length;
    }

    function projectAt(uint256 index) external view returns (address) {
        return projectVaults[index];
    }
}
