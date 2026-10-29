// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./LDXERC20.sol";
import "./FullStopAssetRegistry.sol";

/**
 * @title FullStopERC20Factory
 * @notice Deploys an LDXERC20 token and registers it with the chain's asset
 * registry in one transaction. The factory holds no funds, has no admin
 * control over the tokens it creates, and cannot mint, freeze or upgrade them:
 * every privileged switch is chosen by the creator and recorded at deployment.
 */
contract FullStopERC20Factory {
    struct TokenParams {
        string name;
        string symbol;
        uint8 decimals;
        uint256 initialSupply;
        uint256 maxSupply;
        bool mintable;
        bool burnable;
        bool transferRestricted;
        address supplyRecipient;
    }

    FullStopAssetRegistry public immutable registry;
    address public owner;

    event TokenCreated(address indexed asset, address indexed creator, string name, string symbol, uint256 initialSupply, uint256 maxSupply);

    constructor(address registry_) {
        registry = FullStopAssetRegistry(registry_);
        owner = msg.sender;
    }

    function createToken(TokenParams calldata p) external returns (address asset) {
        asset = address(
            new LDXERC20(
                p.name,
                p.symbol,
                p.decimals,
                p.initialSupply,
                p.maxSupply,
                p.mintable,
                p.burnable,
                p.transferRestricted,
                msg.sender,
                p.supplyRecipient
            )
        );
        registry.register(asset, FullStopAssetRegistry.Kind.ERC20, msg.sender, p.name, p.symbol);
        emit TokenCreated(asset, msg.sender, p.name, p.symbol, p.initialSupply, p.maxSupply);
    }

    /** Deterministic pre-computation helper for wallets that want to preview. */
    function estimateGasCost() external pure returns (uint256) {
        return 2_600_000;
    }
}
