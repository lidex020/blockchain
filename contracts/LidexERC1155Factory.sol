// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./LDXERC1155.sol";
import "./LidexAssetRegistry.sol";

/**
 * @title LidexERC1155Factory
 * @notice Deploys a multi-token collection from the reference template and
 * registers it.
 */
contract LidexERC1155Factory {
    LidexAssetRegistry public immutable registry;
    address public owner;

    event MultiTokenCreated(address indexed asset, address indexed creator, string name, string uriTemplate);

    constructor(address registry_) {
        registry = LidexAssetRegistry(registry_);
        owner = msg.sender;
    }

    function createCollection(string calldata name, string calldata uriTemplate) external returns (address asset) {
        asset = address(new LDXERC1155(name, uriTemplate, msg.sender));
        registry.register(asset, LidexAssetRegistry.Kind.ERC1155, msg.sender, name, "");
        emit MultiTokenCreated(asset, msg.sender, name, uriTemplate);
    }
}
