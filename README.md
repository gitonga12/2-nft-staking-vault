# 🏦 NFT Staking Vault

> Stake ERC-721 NFTs to earn ERC-20 reward tokens. Supports per-token multipliers, lazy reward calculation, batch claiming, and pausable safety switch.

## How It Works

```
User                  NFTStakingVault              RewardToken
 │                         │                           │
 ├── approve(vault, id) ──►│                           │
 ├── stake(tokenId) ──────►│ holds NFT                 │
 │                         │ records StakeInfo          │
 │                    [time passes]                     │
 │                         │                           │
 ├── claimReward(id) ─────►│ calculates elapsed × rate │
 │                         ├── mint(user, reward) ────►│
 │◄────────────── vRWD ────┤◄──────────────────────────┤
 │                         │                           │
 ├── unstake(tokenId) ────►│ returns NFT + final reward│
```

## Reward Formula

```
reward = elapsed_seconds × REWARD_RATE × multiplier_bps / BASIS_POINTS
```

- Base rate: `1e18` tokens per second per NFT (1 vRWD/s)
- Default multiplier: 1x (10,000 bps)
- Example: 2x rare NFT staked for 1 hour = `3600 × 2 = 7,200 vRWD`

## Features

| Feature | Details |
|---|---|
| Multi-stake | Stake any number of NFTs from the same collection |
| Lazy rewards | Calculated on demand, no per-block loops |
| Multipliers | Owner can set per-tokenId bonus multipliers |
| `claimAll()` | Batch claim across all staked NFTs in one tx |
| Pausable | Emergency pause for stake/claim (unstake always works) |
| ReentrancyGuard | Protection on all state-changing functions |

## Setup

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Deploy

```solidity
// Pass your ERC721 collection address
NFTStakingVault vault = new NFTStakingVault(0xYourNFTCollection);
```

The vault auto-deploys a `RewardToken` and takes ownership of it.

## Owner Operations

```typescript
// Set 2x multiplier for tokenId 42 (e.g. legendary tier)
await vault.setMultiplier(42, 20_000);

// Set 0.5x for a common tier
await vault.setMultiplier(1, 5_000);

// Emergency pause
await vault.pause();
await vault.unpause();
```

## User Operations

```typescript
// Approve and stake
await nft.approve(vault.address, tokenId);
await vault.stake(tokenId);

// Check pending rewards
const pending = await vault.pendingReward(tokenId);

// Claim without unstaking
await vault.claimReward(tokenId);

// Claim all in one tx
await vault.claimAll();

// Unstake + final claim
await vault.unstake(tokenId);
```

## License

MIT


