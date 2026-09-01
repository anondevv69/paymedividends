// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IProjectRouterFactory {
    function isProjectRouter(address router) external view returns (bool);
}
