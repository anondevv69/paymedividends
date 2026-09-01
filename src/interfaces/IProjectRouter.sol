// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IProjectRouter {
    function hub() external view returns (address);
    function communityToken() external view returns (address);
    function poolBound() external view returns (bool);
}
