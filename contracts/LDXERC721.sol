// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title LDXERC721
 * @notice Reference ERC-721 used by the Lidex NFT creator.
 *
 * Metadata model: token JSON is stored on-chain (see `tokenURI`), which means
 * the artwork reference is a normal `image` field pointing at external storage
 * chosen by the creator. The creator UI must explain that if that external
 * storage disappears the image reference breaks while the token itself stays
 * on-chain.
 */
contract LDXERC721 {
    string public name;
    string public symbol;

    address public owner;
    address public pendingOwner;
    bool public immutable mintableByOwner;
    bool public maxSupplySet;
    uint256 public maxSupply;
    uint256 public nextId = 1;
    uint256 public totalMinted;
    string public contractURI;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operators;
    mapping(uint256 => string) private _meta;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed tokenOwner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event Minted(address indexed to, uint256 indexed tokenId, string uri);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ContractURIUpdated(string newURI);

    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error UnknownToken(uint256 id);
    error ExceedsMaxSupply(uint256 cap);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(string memory name_, string memory symbol_, uint256 maxSupply_, string memory contractURI_, address owner_) {
        name = name_;
        symbol = symbol_;
        maxSupplySet = maxSupply_ > 0;
        maxSupply = maxSupply_;
        contractURI = contractURI_;
        mintableByOwner = true;
        owner = owner_ == address(0) ? msg.sender : owner_;
    }

    // ------------------------------------------------------------- ERC-721

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return _balances[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        if (o == address(0)) revert UnknownToken(tokenId);
        return o;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_owners[tokenId] == address(0)) revert UnknownToken(tokenId);
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return _operators[account][operator];
    }

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert UnknownToken(tokenId);
        if (msg.sender != tokenOwner && !isApprovedForAll(tokenOwner, msg.sender)) revert NotAuthorized();
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner != from) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != from && !isApprovedForAll(from, msg.sender) && _tokenApprovals[tokenId] != msg.sender) {
            revert NotAuthorized();
        }
        delete _tokenApprovals[tokenId];
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (_isContract(to)) {
          (bool ok, bytes memory ret) = to.call(
                abi.encodeWithSelector(this.onERC721Received.selector, msg.sender, from, tokenId, data)
            );
            require(ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == this.onERC721Received.selector, "ERC721: unsafe recipient");
        }
    }

    bytes4 internal constant ERC721_RECEIVED = 0x150b7a02;

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return ERC721_RECEIVED;
    }

    // ---------------------------------------------------------------- mint

    /**
     * @param uri per-token metadata JSON. Stored on-chain.
     */
    function mint(address to, string calldata uri) external returns (uint256 id) {
        require(mintableByOwner, "collection is closed to minting");
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (maxSupplySet && totalMinted >= maxSupply) revert ExceedsMaxSupply(maxSupply);
        id = nextId++;
        unchecked {
            totalMinted += 1;
            _balances[to] += 1;
        }
        _owners[id] = to;
        _meta[id] = uri;
        emit Transfer(address(0), to, id);
        emit Minted(to, id, uri);
    }

    /** Set the metadata reference for a token (owner only, e.g. after IPFS pinning). */
    function setTokenURI(uint256 tokenId, string calldata uri) external onlyOwner {
        if (_owners[tokenId] == address(0)) revert UnknownToken(tokenId);
        _meta[tokenId] = uri;
    }

    function tokenURI(uint256 tokenId) public view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert UnknownToken(tokenId);
        return _meta[tokenId];
    }

    function tokensOf(address account) external view returns (uint256[] memory ids) {
        uint256 n = _balances[account];
        ids = new uint256[](n);
        uint256 c = 0;
        for (uint256 i = 1; i < nextId && c < n; i++) {
            if (_owners[i] == account) ids[c++] = i;
        }
    }

    function updateContractURI(string calldata newURI) external onlyOwner {
        contractURI = newURI;
        emit ContractURIUpdated(newURI);
    }

    function permissions()
        external
        view
        returns (address currentOwner, bool canMint, bool capEnabled, uint256 cap, uint256 minted)
    {
        return (owner, mintableByOwner, maxSupplySet, maxSupply, totalMinted);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _isContract(address a) internal view returns (bool) {
        return a.code.length > 0;
    }
}
