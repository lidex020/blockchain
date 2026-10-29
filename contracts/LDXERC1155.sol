// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title LDXERC1155
 * @notice Reference ERC-1155 for Lidex multi-token collections: one
 * contract holding many token types, each fungible or single-edition
 * depending on how the creator mints it. Safe mint and transfer entrypoints
 * enforce the ERC-1155 receiver acceptance callbacks for contract recipients.
 */
contract LDXERC1155 {
    string public uriTemplate; // template containing {id}
    string public name;
    address public owner;
    address public pendingOwner;
    bool public immutable mintableByOwner;
    uint256 public typeCount;
    mapping(uint256 => uint256) public totalSupply;
    mapping(uint256 => uint256) public maxSupply; // 0 == uncapped
    mapping(uint256 => bool) public exists;
    mapping(address => mapping(uint256 => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operators;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);
    event TypeAdded(uint256 indexed id, uint256 cap);
    event Minted(address indexed to, uint256 indexed id, uint256 value);
    event Burned(address indexed from, uint256 indexed id, uint256 value);

    error NotOwner();
    error NotAuthorized();
    error UnknownType(uint256 id);
    error ExceedsMaxSupply(uint256 id, uint256 cap, uint256 requested);
    error LengthMismatch();
    error ZeroAddress();
    error UnsafeRecipient(address recipient);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(string memory name_, string memory uri_, address owner_) {
        name = name_;
        uriTemplate = uri_;
        owner = owner_ == address(0) ? msg.sender : owner_;
        mintableByOwner = true;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0xd9b67a26 || id == 0x0e89341c;
    }

    /** Register a token type. `cap` of 0 means uncapped. */
    function addType(uint256 id, uint256 cap) public onlyOwner {
        require(!exists[id], "type already exists");
        exists[id] = true;
        maxSupply[id] = cap;
        typeCount += 1;
        emit TypeAdded(id, cap);
    }

    function mint(address to, uint256 id, uint256 value, bytes calldata data) public onlyOwner {
        _mint(to, id, value);
        _doSafeTransferAcceptanceCheck(msg.sender, address(0), to, id, value, data);
    }

    function _mint(address to, uint256 id, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        if (!exists[id]) {
            exists[id] = true;
            typeCount += 1;
            emit TypeAdded(id, 0);
        }
        uint256 cap = maxSupply[id];
        uint256 next = totalSupply[id] + value;
        if (cap > 0 && next > cap) revert ExceedsMaxSupply(id, cap, value);
        totalSupply[id] = next;
        _balances[to][id] += value;
        emit TransferSingle(msg.sender, address(0), to, id, value);
        emit Minted(to, id, value);
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external onlyOwner {
        require(ids.length == values.length, "length mismatch");
        if (to == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < ids.length; i++) {
            _mint(to, ids[i], values[i]);
        }
        emit TransferBatch(msg.sender, address(0), to, ids, values);
        _doSafeBatchTransferAcceptanceCheck(msg.sender, address(0), to, ids, values, data);
    }

    function burn(address from, uint256 id, uint256 value) external onlyOwner {
        uint256 bal = _balances[from][id];
        require(bal >= value, "insufficient balance");
        unchecked {
            _balances[from][id] = bal - value;
            totalSupply[id] -= value;
        }
        emit TransferSingle(msg.sender, from, address(0), id, value);
        emit Burned(from, id, value);
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[account][id];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory out) {
        require(accounts.length == ids.length, "length mismatch");
        out = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) out[i] = _balances[accounts[i]][ids[i]];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return _operators[account][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) public {
        require(msg.sender == from || isApprovedForAll(from, msg.sender), "not authorized");
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = _balances[from][id];
        require(bal >= value, "insufficient balance");
        unchecked {
            _balances[from][id] = bal - value;
        }
        _balances[to][id] += value;
        emit TransferSingle(msg.sender, from, to, id, value);
        _doSafeTransferAcceptanceCheck(msg.sender, from, to, id, value, data);
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) public {
        require(msg.sender == from || isApprovedForAll(from, msg.sender), "not authorized");
        if (to == address(0)) revert ZeroAddress();
        require(ids.length == values.length, "length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 bal = _balances[from][ids[i]];
            require(bal >= values[i], "insufficient balance");
            unchecked {
                _balances[from][ids[i]] = bal - values[i];
            }
            _balances[to][ids[i]] += values[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, values);
        _doSafeBatchTransferAcceptanceCheck(msg.sender, from, to, ids, values, data);
    }

    function _doSafeTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) private {
        if (to.code.length == 0) return;
        bytes4 selector = 0xf23a6e61;
        (bool ok, bytes memory response) = to.call(
            abi.encodeWithSelector(selector, operator, from, id, value, data)
        );
        if (!ok || response.length < 32 || abi.decode(response, (bytes4)) != selector) {
            revert UnsafeRecipient(to);
        }
    }

    function _doSafeBatchTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) private {
        if (to.code.length == 0) return;
        bytes4 selector = 0xbc197c81;
        (bool ok, bytes memory response) = to.call(
            abi.encodeWithSelector(selector, operator, from, ids, values, data)
        );
        if (!ok || response.length < 32 || abi.decode(response, (bytes4)) != selector) {
            revert UnsafeRecipient(to);
        }
    }

    function uri(uint256 id) public view returns (string memory) {
        bytes memory u = bytes(uriTemplate);
        bytes memory open = "{id}";
        uint256 len = 0;
        for (uint256 i = 0; i < u.length; i++) if (u[i] == "{") len++;
        if (len == 0) return uriTemplate;
        // Replace the first {id} occurrence with the decimal id.
        string memory idStr = _toString(id);
        bytes memory outBytes = new bytes(u.length - 3 + bytes(idStr).length);
        uint256 j = 0;
        bool replaced = false;
        for (uint256 i = 0; i < u.length; i++) {
            if (!replaced && i + 3 <= u.length && u[i] == open[0] && u[i + 1] == open[1] && u[i + 2] == open[2] && u[i + 3] == "}") {
                for (uint256 k = 0; k < bytes(idStr).length; k++) outBytes[j++] = bytes(idStr)[k];
                i += 3;
                replaced = true;
            } else {
                outBytes[j++] = u[i];
            }
        }
        return string(outBytes);
    }

    function permissions() external view returns (address currentOwner, bool canMint, uint256 types) {
        return (owner, mintableByOwner, typeCount);
    }

    function updateURI(string calldata newURI) external onlyOwner {
        uriTemplate = newURI;
        emit URI(newURI, 0);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n != 0) {
            len++;
            n /= 10;
        }
        bytes memory b = new bytes(len);
        while (v != 0) {
            len--;
            b[len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
