// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title FSTOPERC20
 * @notice Reference ERC-20 implementation deployed by the Full Stop asset
 * creator. Deliberately minimal and readable: every privileged behaviour is
 * either switched on at creation time and permanent, or controlled by the
 * owner and disclosed by `permissions()`.
 *
 * Security notes for users of the creator:
 *  - `mintable` is permanent: anyone who is owner can mint at any time.
 *  - `maxSupply == 0` means this token has no cap of its own.
 *  - `transferRestricted` blocks transfers to addresses the owner has not
 *    allowed; that makes the token non-cancellable only in one direction and
 *    is a serious centralisation risk.
 */
contract FSTOPERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    /// 0 == no per-token cap.
    uint256 public immutable maxSupply;
    bool public immutable mintable;
    bool public immutable burnable;
    bool public immutable transferRestricted;

    address public owner;
    address public pendingOwner;
    bool public paused;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public transferAllowed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed nextOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Minted(address indexed to, uint256 value);
    event Burned(address indexed from, uint256 value);
    event TransferAllowedSet(address indexed account, bool allowed);
    event PausedSet(bool paused);

    error NotOwner();
    error NotMintable();
    error NotBurnable();
    error ExceedsMaxSupply(uint256 cap, uint256 total);
    error TransferBlocked(address to);
    error Paused();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        uint256 maxSupply_,
        bool mintable_,
        bool burnable_,
        bool transferRestricted_,
        address owner_,
        address supplyRecipient
    ) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        maxSupply = maxSupply_;
        mintable = mintable_;
        burnable = burnable_;
        transferRestricted = transferRestricted_;
        owner = owner_ == address(0) ? msg.sender : owner_;
        if (initialSupply_ > 0) {
            if (maxSupply_ > 0 && initialSupply_ > maxSupply_) revert ExceedsMaxSupply(maxSupply_, initialSupply_);
            totalSupply = initialSupply_;
            address to = supplyRecipient == address(0) ? owner : supplyRecipient;
            balanceOf[to] = initialSupply_;
            emit Transfer(address(0), to, initialSupply_);
        }
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        _checkTransfer(to);
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        _checkTransfer(to);
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "ERC20: allowance exceeded");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /** Increase an allowance without the two-step race (a small ERC-20 QoL fix). */
    function increaseAllowance(address spender, uint256 addedValue) external returns (bool) {
        allowance[msg.sender][spender] += addedValue;
        emit Approval(msg.sender, spender, allowance[msg.sender][spender]);
        return true;
    }

    function mint(address to, uint256 value) external onlyOwner {
        if (!mintable) revert NotMintable();
        uint256 next = totalSupply + value;
        if (maxSupply > 0 && next > maxSupply) revert ExceedsMaxSupply(maxSupply, next);
        totalSupply = next;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
        emit Minted(to, value);
    }

    function burn(uint256 value) external {
        if (!burnable) revert NotBurnable();
        _burn(msg.sender, value);
    }

    function burnFrom(address from, uint256 value) external onlyOwner {
        if (!burnable) revert NotBurnable();
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "ERC20: allowance exceeded");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _burn(from, value);
    }

    function _checkTransfer(address to) internal view {
        if (paused) revert Paused();
        if (transferRestricted && !transferAllowed[to] && msg.sender != owner) revert TransferBlocked(to);
    }

    function _transfer(address from, address to, uint256 value) internal {
        uint256 bal = balanceOf[from];
        require(bal >= value, "ERC20: insufficient balance");
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _burn(address from, uint256 value) internal {
        uint256 bal = balanceOf[from];
        require(bal >= value, "ERC20: insufficient balance");
        unchecked {
            balanceOf[from] = bal - value;
            totalSupply -= value;
        }
        emit Transfer(from, address(0), value);
        emit Burned(from, value);
    }

    // ---- owner controls, all disclosed by permissions() ----

    function setTransferAllowed(address account, bool allowed) external onlyOwner {
        transferAllowed[account] = allowed;
        emit TransferAllowedSet(account, allowed);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /** One call that discloses every privileged setting, for explorers and wallets. */
    function permissions()
        external
        view
        returns (
            address currentOwner,
            bool canMint,
            bool canBurn,
            bool transfersRestricted,
            uint256 cap,
            bool capUnlimited,
            bool pausedNow
        )
    {
        return (owner, mintable, burnable, transferRestricted, maxSupply, maxSupply == 0, paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "ERC20: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
