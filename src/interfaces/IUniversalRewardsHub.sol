// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IUniversalRewardsHub {
    function settlementAsset() external view returns (address);
    function isApprovedAsset(address asset) external view returns (bool);
    function isApprovedFeeManager(address feeManager) external view returns (bool);
    function minimumRouterFeeShare() external view returns (uint256);
    function isApprovedPoolBinding(address feeManager, bytes32 poolId, address communityToken, address pairedAsset)
        external
        view
        returns (bool);
    function deposit(address asset, uint256 amount) external returns (uint256 netAmount);
}
