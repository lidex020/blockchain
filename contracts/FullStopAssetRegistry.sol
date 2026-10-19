// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title FullStopAssetRegistry
 * @notice On-chain index of digital assets created through the official Full
 * Stop asset-creation factories.
 *
 * The registry exists so that a wallet or explorer can tell "created with the
 * audited reference template" from "hand-written contract". Registration is
 * only open to the factories configured at deployment.
 *
 * Listing here is not an endorsement, and grants no value, liquidity or
 * exchange listing. Users who deploy a contract directly are not in this list
 * and are not second-class: the registry is a convenience index only.
 */
contract FullStopAssetRegistry {
    enum Kind {
        None,
        ERC20,
        ERC721,
        ERC1155
    }

    struct Asset {
        address contractAddress;
        Kind kind;
        address creator;
        uint256 blockNumber;
        string name;
        string symbol;
    }

    address public owner;
    mapping(address => bool) public factories;
    Asset[] private _assets;
    mapping(address => uint256) private _indexPlusOne;

    event AssetRegistered(uint256 indexed index, address indexed contractAddress, uint8 kind, address indexed creator, string name, string symbol);
    event FactorySet(address indexed factory, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotFactory();
    error AlreadyRegistered();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyFactory() {
        if (!factories[msg.sender]) revert NotFactory();
        _;
    }

    constructor(address[] memory allowedFactories) {
        owner = msg.sender;
        for (uint256 i = 0; i < allowedFactories.length; i++) {
            factories[allowedFactories[i]] = true;
            emit FactorySet(allowedFactories[i], true);
        }
    }

    function register(
        address asset,
        Kind kind,
        address creator,
        string calldata name,
        string calldata symbol
    ) external onlyFactory {
        if (asset == address(0) || _indexPlusOne[asset] != 0) revert AlreadyRegistered();
        _assets.push(Asset({contractAddress: asset, kind: kind, creator: creator, blockNumber: block.number, name: name, symbol: symbol}));
        _indexPlusOne[asset] = _assets.length;
        emit AssetRegistered(_assets.length - 1, asset, uint8(kind), creator, name, symbol);
    }

    function setFactory(address factory, bool allowed) external onlyOwner {
        factories[factory] = allowed;
        emit FactorySet(factory, allowed);
    }

    function assetCount() external view returns (uint256) {
        return _assets.length;
    }

    function assetAt(uint256 index) external view returns (Asset memory) {
        return _assets[index];
    }

    /// Newest first, which is what a creation dashboard wants.
    function latest(uint256 limit) external view returns (Asset[] memory page) {
        uint256 total = _assets.length;
        uint256 n = limit > total ? total : limit;
        page = new Asset[](n);
        for (uint256 i = 0; i < n; i++) page[i] = _assets[total - 1 - i];
    }

    function assets(uint256 offset, uint256 limit) external view returns (Asset[] memory page, uint256 total) {
        total = _assets.length;
        if (offset >= total) return (new Asset[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new Asset[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = _assets[i];
    }

    function assetOf(address contractAddress) external view returns (Asset memory a, bool known) {
        uint256 idx = _indexPlusOne[contractAddress];
        if (idx == 0) return (a, false);
        return (_assets[idx - 1], true);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
