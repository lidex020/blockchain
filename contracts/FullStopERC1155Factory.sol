// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./LDXERC1155.sol";
import "./FullStopAssetRegistry.sol";

/**
 * @title FullStopERC1155Factory
 * @notice Deploys a multi-token collection from the reference template and
 * registers it.
 */
contract FullStopERC1155Factory {
    FullStopAssetRegistry public immutable registry;
    address public owner;

    event MultiTokenCreated(address indexed asset, address indexed creator, string name, string uriTemplate);

    constructor(address registry_) {
        registry = FullStopAssetRegistry(registry_);
        owner = msg.sender;
    }

    function createCollection(string calldata name, string calldata uriTemplate) external returns (address asset) {
        asset = address(new LDXERC1155(name, uriTemplate, msg.sender));
        registry.register(asset, FullStopAssetRegistry.Kind.ERC1155, msg.sender, name, "");
        emit MultiTokenCreated(asset, msg.sender, name, uriTemplate);
    }
}
