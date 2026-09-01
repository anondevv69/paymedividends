// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal Doppler-compatible fee manager interface used by Bankr launches.
/// @dev The configured vault must be the pool's fee beneficiary. A production integration must
///      verify the manager address and pool metadata against the Robinhood Chain deployment.
interface IDopplerFeeManager {
    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256 shares);
    function collectFees(bytes32 poolId) external returns (uint256 amount0, uint256 amount1);
    function updateBeneficiary(bytes32 poolId, address newBeneficiary) external;
}
