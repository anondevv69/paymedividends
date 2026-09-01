// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IProjectRouter {
    function hub() external view returns (address);
    function projectAdmin() external view returns (address);
    function communityToken() external view returns (address);
    function pairedAsset() external view returns (address);
    function feeManager() external view returns (address);
    function dopplerPoolId() external view returns (bytes32);
    function poolBound() external view returns (bool);
}
