// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title MerkleStakingVault
 * @notice Extension of NFTStakingVault that uses a Merkle tree to restrict
 *         which tokenIds are eligible for staking — useful for allowing only
 *         specific token ranges, trait-based subsets, or whitelisted IDs.
 *
 *  Off-chain flow:
 *  1. Build a Merkle tree where each leaf = keccak256(abi.encodePacked(tokenId))
 *  2. Store the root on-chain via setMerkleRoot()
 *  3. Users pass their proof when calling stake()
 */
contract MerkleStakingVault is IERC721Receiver, Ownable, ReentrancyGuard {

    // ─── Reward token ─────────────────────────────────────────────────────────

    ERC20MintableByVault public immutable rewardToken;

    // ─── NFT collection ───────────────────────────────────────────────────────

    IERC721 public immutable nftCollection;

    // ─── Merkle ───────────────────────────────────────────────────────────────

    bytes32 public merkleRoot;
    bool    public merkleEnabled; // if false, all tokenIds are eligible

    // ─── Staking ──────────────────────────────────────────────────────────────

    uint256 public constant BASE_RATE   = 1e18; // 1 token/second
    uint256 public constant BASIS_POINTS = 10_000;

    struct StakeInfo {
        address owner;
        uint256 lastClaimed;
        uint256 multiplierBps;
    }

    mapping(uint256 => StakeInfo) public stakes;
    mapping(address => uint256[]) private _stakedTokens;
    mapping(address => mapping(uint256 => uint256)) private _tokenIndex;

    uint256 public totalStaked;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Staked(address indexed user, uint256 indexed tokenId);
    event Unstaked(address indexed user, uint256 indexed tokenId, uint256 reward);
    event Claimed(address indexed user, uint256 indexed tokenId, uint256 reward);
    event MerkleRootUpdated(bytes32 newRoot);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error InvalidProof(uint256 tokenId);
    error NotOwner(uint256 tokenId);
    error AlreadyStaked(uint256 tokenId);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _nft, bytes32 _merkleRoot, bool _merkleEnabled)
        Ownable(msg.sender)
    {
        nftCollection  = IERC721(_nft);
        merkleRoot     = _merkleRoot;
        merkleEnabled  = _merkleEnabled;
        rewardToken    = new ERC20MintableByVault("Merkle Vault Reward", "MVR");
    }

    // ─── Staking ──────────────────────────────────────────────────────────────

    /**
     * @param tokenId   NFT to stake.
     * @param proof     Merkle proof that tokenId is whitelisted.
     * @param multiplierBps  Caller-supplied multiplier (validated via proof leaf).
     *                       Pass 10_000 for 1x if no per-token boosts are used.
     */
    function stake(
        uint256 tokenId,
        bytes32[] calldata proof,
        uint256 multiplierBps
    ) external nonReentrant {
        if (nftCollection.ownerOf(tokenId) != msg.sender) revert NotOwner(tokenId);
        if (stakes[tokenId].owner != address(0)) revert AlreadyStaked(tokenId);

        if (merkleEnabled) {
            // Leaf encodes both tokenId and multiplier to prevent manipulation
            bytes32 leaf = keccak256(abi.encodePacked(tokenId, multiplierBps));
            if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof(tokenId);
        }

        nftCollection.safeTransferFrom(msg.sender, address(this), tokenId);

        stakes[tokenId] = StakeInfo({
            owner:         msg.sender,
            lastClaimed:   block.timestamp,
            multiplierBps: multiplierBps == 0 ? BASIS_POINTS : multiplierBps
        });

        _stakedTokens[msg.sender].push(tokenId);
        _tokenIndex[msg.sender][tokenId] = _stakedTokens[msg.sender].length - 1;
        totalStaked++;

        emit Staked(msg.sender, tokenId);
    }

    function unstake(uint256 tokenId) external nonReentrant {
        StakeInfo memory info = stakes[tokenId];
        if (info.owner != msg.sender) revert NotOwner(tokenId);

        uint256 reward = _pendingReward(tokenId);
        delete stakes[tokenId];
        _removeToken(msg.sender, tokenId);
        totalStaked--;

        nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);
        if (reward > 0) rewardToken.mint(msg.sender, reward);

        emit Unstaked(msg.sender, tokenId, reward);
    }

    function claim(uint256 tokenId) external nonReentrant {
        StakeInfo storage info = stakes[tokenId];
        if (info.owner != msg.sender) revert NotOwner(tokenId);

        uint256 reward = _pendingReward(tokenId);
        info.lastClaimed = block.timestamp;
        if (reward > 0) rewardToken.mint(msg.sender, reward);

        emit Claimed(msg.sender, tokenId, reward);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function pendingReward(uint256 tokenId) external view returns (uint256) {
        return _pendingReward(tokenId);
    }

    function stakedTokensOf(address user) external view returns (uint256[] memory) {
        return _stakedTokens[user];
    }

    // ─── Owner ────────────────────────────────────────────────────────────────

    function setMerkleRoot(bytes32 newRoot) external onlyOwner {
        merkleRoot = newRoot;
        emit MerkleRootUpdated(newRoot);
    }

    function setMerkleEnabled(bool enabled) external onlyOwner {
        merkleEnabled = enabled;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _pendingReward(uint256 tokenId) internal view returns (uint256) {
        StakeInfo memory info = stakes[tokenId];
        if (info.owner == address(0)) return 0;
        uint256 elapsed = block.timestamp - info.lastClaimed;
        return (elapsed * BASE_RATE * info.multiplierBps) / BASIS_POINTS;
    }

    function _removeToken(address user, uint256 tokenId) internal {
        uint256 idx  = _tokenIndex[user][tokenId];
        uint256 last = _stakedTokens[user][_stakedTokens[user].length - 1];
        _stakedTokens[user][idx] = last;
        _tokenIndex[user][last]  = idx;
        _stakedTokens[user].pop();
        delete _tokenIndex[user][tokenId];
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Minimal mintable ERC20 owned by the vault.
contract ERC20MintableByVault is ERC20, Ownable {
    constructor(string memory name, string memory symbol)
        ERC20(name, symbol)
        Ownable(msg.sender)
    {}
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
