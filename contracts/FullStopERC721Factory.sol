// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./FSTOPERC721.sol";
import "./FullStopAssetRegistry.sol";

/**
 * @title FullStopERC721Factory
 * @notice Deploys an NFT collection from the reference template and registers
 * it. Ownership of the collection goes to the caller; the factory keeps no
 * rights over it.
 */
contract FullStopERC721Factory {
    struct CollectionParams {
        string name;
        string symbol;
        uint256 maxSupply;
        string contractURI;
    }

    FullStopAssetRegistry public immutable registry;
    address public owner;

    event CollectionCreated(address indexed asset, address indexed creator, string name, string symbol, uint256 maxSupply);

    constructor(address registry_) {
        registry = FullStopAssetRegistry(registry_);
        owner = msg.sender;
    }

    function createCollection(CollectionParams calldata p) external returns (address asset) {
        asset = address(new FSTOPERC721(p.name, p.symbol, p.maxSupply, p.contractURI, msg.sender));
        registry.register(asset, FullStopAssetRegistry.Kind.ERC721, msg.sender, p.name, p.symbol);
        emit CollectionCreated(asset, msg.sender, p.name, p.symbol, p.maxSupply);
    }
}
