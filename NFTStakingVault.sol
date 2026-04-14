// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title RewardToken
 * @notice Simple ERC20 minted exclusively by the staking vault.
 */
contract RewardToken is ERC20, Ownable {
    constructor() ERC20("Vault Reward", "vRWD") Ownable(msg.sender) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

/**
 * @title NFTStakingVault
 * @notice Stake ERC-721 NFTs to earn ERC-20 reward tokens over time.
 *
 *  Reward model
 *  ─────────────
 *  Each staked NFT accumulates `REWARD_RATE` tokens per second.
 *  Rewards are calculated lazily — only on stake/unstake/claim.
 *  Multiple NFTs from the same collection can be staked simultaneously.
 *
 *  Multipliers
 *  ───────────
 *  The owner can assign per-tokenId multipliers (e.g. 2x for rare NFTs).
 *  Default multiplier is 1x (100 basis points = 1.00x).
 */
contract NFTStakingVault is IERC721Receiver, Ownable, ReentrancyGuard, Pausable {

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant REWARD_RATE    = 1e18;    // 1 token per second per NFT (base)
    uint256 public constant BASIS_POINTS   = 10_000;  // 1x multiplier = 10_000 bp

    // ─── Immutables ───────────────────────────────────────────────────────────

    IERC721     public immutable nftCollection;
    RewardToken public immutable rewardToken;

    // ─── Storage ──────────────────────────────────────────────────────────────

    struct StakeInfo {
        address owner;
        uint256 stakedAt;
        uint256 lastClaimed;
    }

    /// tokenId → StakeInfo
    mapping(uint256 => StakeInfo) public stakes;

    /// tokenId → reward multiplier in basis points (default 10_000 = 1x)
    mapping(uint256 => uint256) public multipliers;

    /// staker → list of staked tokenIds
    mapping(address => uint256[]) private _stakedTokens;

    /// staker → index of tokenId in _stakedTokens array
    mapping(address => mapping(uint256 => uint256)) private _tokenIndex;

    uint256 public totalStaked;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Staked(address indexed user, uint256 indexed tokenId);
    event Unstaked(address indexed user, uint256 indexed tokenId, uint256 reward);
    event RewardClaimed(address indexed user, uint256 indexed tokenId, uint256 reward);
    event MultiplierSet(uint256 indexed tokenId, uint256 multiplierBps);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotTokenOwner(uint256 tokenId);
    error TokenNotStaked(uint256 tokenId);
    error TokenAlreadyStaked(uint256 tokenId);
    error InvalidMultiplier();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _nftCollection) Ownable(msg.sender) {
        nftCollection = IERC721(_nftCollection);
        rewardToken   = new RewardToken();
        // Transfer reward token ownership to this vault so it can mint
        rewardToken.transferOwnership(address(this));
    }

    // ─── Staking ──────────────────────────────────────────────────────────────

    /**
     * @notice Stake one NFT. Caller must have approved this contract.
     * @param tokenId The NFT to stake.
     */
    function stake(uint256 tokenId) external nonReentrant whenNotPaused {
        if (stakes[tokenId].owner != address(0)) revert TokenAlreadyStaked(tokenId);
        if (nftCollection.ownerOf(tokenId) != msg.sender) revert NotTokenOwner(tokenId);

        nftCollection.safeTransferFrom(msg.sender, address(this), tokenId);

        stakes[tokenId] = StakeInfo({
            owner:       msg.sender,
            stakedAt:    block.timestamp,
            lastClaimed: block.timestamp
        });

        _stakedTokens[msg.sender].push(tokenId);
        _tokenIndex[msg.sender][tokenId] = _stakedTokens[msg.sender].length - 1;
        totalStaked++;

        emit Staked(msg.sender, tokenId);
    }

    /**
     * @notice Unstake an NFT and collect all pending rewards.
     * @param tokenId The NFT to unstake.
     */
    function unstake(uint256 tokenId) external nonReentrant {
        StakeInfo memory info = stakes[tokenId];
        if (info.owner != msg.sender) revert NotTokenOwner(tokenId);

        uint256 reward = _pendingReward(tokenId);
        delete stakes[tokenId];

        _removeFromStakedList(msg.sender, tokenId);
        totalStaked--;

        nftCollection.safeTransferFrom(address(this), msg.sender, tokenId);

        if (reward > 0) {
            rewardToken.mint(msg.sender, reward);
        }

        emit Unstaked(msg.sender, tokenId, reward);
    }

    /**
     * @notice Claim pending rewards for a staked NFT without unstaking.
     * @param tokenId The NFT to claim rewards for.
     */
    function claimReward(uint256 tokenId) external nonReentrant whenNotPaused {
        StakeInfo storage info = stakes[tokenId];
        if (info.owner != msg.sender) revert NotTokenOwner(tokenId);

        uint256 reward = _pendingReward(tokenId);
        info.lastClaimed = block.timestamp;

        if (reward > 0) {
            rewardToken.mint(msg.sender, reward);
        }

        emit RewardClaimed(msg.sender, tokenId, reward);
    }

    /**
     * @notice Claim rewards for all staked NFTs in one transaction.
     */
    function claimAll() external nonReentrant whenNotPaused {
        uint256[] memory tokenIds = _stakedTokens[msg.sender];
        uint256 totalReward;

        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];
            totalReward += _pendingReward(tokenId);
            stakes[tokenId].lastClaimed = block.timestamp;
        }

        if (totalReward > 0) {
            rewardToken.mint(msg.sender, totalReward);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Returns pending unclaimed rewards for a tokenId.
    function pendingReward(uint256 tokenId) external view returns (uint256) {
        return _pendingReward(tokenId);
    }

    /// @notice Returns all tokenIds staked by a user.
    function stakedTokensOf(address user) external view returns (uint256[] memory) {
        return _stakedTokens[user];
    }

    /// @notice Returns total pending rewards across all staked NFTs of a user.
    function totalPendingRewards(address user) external view returns (uint256 total) {
        uint256[] memory tokenIds = _stakedTokens[user];
        for (uint256 i; i < tokenIds.length; ++i) {
            total += _pendingReward(tokenIds[i]);
        }
    }

    // ─── Owner ────────────────────────────────────────────────────────────────

    /// @notice Set a reward multiplier for a specific tokenId.
    /// @param bps Basis points — e.g. 20_000 = 2x, 5_000 = 0.5x. Must be > 0.
    function setMultiplier(uint256 tokenId, uint256 bps) external onlyOwner {
        if (bps == 0) revert InvalidMultiplier();
        multipliers[tokenId] = bps;
        emit MultiplierSet(tokenId, bps);
    }

    function pause()   external onlyOwner { _pause();   }
    function unpause() external onlyOwner { _unpause(); }

    // ─── ERC721Receiver ───────────────────────────────────────────────────────

    function onERC721Received(address, address, uint256, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _pendingReward(uint256 tokenId) internal view returns (uint256) {
        StakeInfo memory info = stakes[tokenId];
        if (info.owner == address(0)) return 0;

        uint256 elapsed     = block.timestamp - info.lastClaimed;
        uint256 bps         = multipliers[tokenId] == 0 ? BASIS_POINTS : multipliers[tokenId];
        return (elapsed * REWARD_RATE * bps) / BASIS_POINTS;
    }

    function _removeFromStakedList(address user, uint256 tokenId) internal {
        uint256 idx  = _tokenIndex[user][tokenId];
        uint256 last = _stakedTokens[user][_stakedTokens[user].length - 1];

        _stakedTokens[user][idx] = last;
        _tokenIndex[user][last]  = idx;
        _stakedTokens[user].pop();
        delete _tokenIndex[user][tokenId];
    }
}
