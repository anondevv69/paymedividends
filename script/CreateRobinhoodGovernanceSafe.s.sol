// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface VmCreateSafe {
    function envAddress(string calldata name) external returns (address value);
    function envUint(string calldata name) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function masterCopy() external view returns (address);
}

/// @notice Creates a 2-of-3 Safe v1.5.0 using Safe's canonical Robinhood Chain contracts.
contract CreateRobinhoodGovernanceSafe {
    VmCreateSafe internal constant vm = VmCreateSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    address internal constant SAFE_L2_SINGLETON = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e;
    address internal constant SAFE_PROXY_FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address internal constant COMPATIBILITY_FALLBACK_HANDLER = 0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4;

    error WrongChain();
    error MissingCanonicalSafeContracts();
    error InvalidOwners();
    error SafeVerificationFailed();

    function run() external returns (address safe) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();
        if (
            SAFE_L2_SINGLETON.code.length == 0 || SAFE_PROXY_FACTORY.code.length == 0
                || COMPATIBILITY_FALLBACK_HANDLER.code.length == 0
        ) revert MissingCanonicalSafeContracts();

        address owner1 = vm.envAddress("SAFE_OWNER_1");
        address owner2 = vm.envAddress("SAFE_OWNER_2");
        address owner3 = vm.envAddress("SAFE_OWNER_3");
        if (
            owner1 == address(0) || owner2 == address(0) || owner3 == address(0) || owner1 == owner2 || owner1 == owner3
                || owner2 == owner3
        ) revert InvalidOwners();

        address[] memory owners = new address[](3);
        owners[0] = owner1;
        owners[1] = owner2;
        owners[2] = owner3;
        bytes memory initializer = abi.encodeCall(
            ISafeSetup.setup,
            (owners, 2, address(0), bytes(""), COMPATIBILITY_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 saltNonce = vm.envUint("SAFE_SALT_NONCE");
        vm.startBroadcast(deployerPrivateKey);
        safe = ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_L2_SINGLETON, initializer, saltNonce);
        vm.stopBroadcast();

        if (
            safe.code.length == 0 || ISafeSetup(safe).getThreshold() != 2
                || ISafeSetup(safe).masterCopy() != SAFE_L2_SINGLETON
        ) revert SafeVerificationFailed();
        address[] memory deployedOwners = ISafeSetup(safe).getOwners();
        if (
            deployedOwners.length != 3 || !_contains(deployedOwners, owner1) || !_contains(deployedOwners, owner2)
                || !_contains(deployedOwners, owner3)
        ) revert SafeVerificationFailed();
    }

    function _contains(address[] memory owners, address expected) private pure returns (bool) {
        for (uint256 i; i < owners.length; ++i) {
            if (owners[i] == expected) return true;
        }
        return false;
    }
}
