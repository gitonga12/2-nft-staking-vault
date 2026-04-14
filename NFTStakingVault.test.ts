import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { NFTStakingVault, RewardToken } from "../typechain-types";

describe("NFTStakingVault", () => {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    // Deploy mock ERC721
    const MockNFT = await ethers.getContractFactory("MockERC721");
    const nft = await MockNFT.deploy("TestNFT", "TNFT");
    await nft.waitForDeployment();

    // Deploy vault
    const Vault = await ethers.getContractFactory("NFTStakingVault");
    const vault = await Vault.deploy(await nft.getAddress()) as NFTStakingVault;
    await vault.waitForDeployment();

    const rewardTokenAddr = await vault.rewardToken();
    const rewardToken = await ethers.getContractAt("RewardToken", rewardTokenAddr) as RewardToken;

    // Mint NFTs to alice and bob
    for (let i = 1; i <= 5; i++) await nft.mint(alice.address, i);
    for (let i = 6; i <= 8; i++) await nft.mint(bob.address, i);

    return { vault, nft, rewardToken, owner, alice, bob };
  }

  describe("Staking", () => {
    it("stakes an NFT and updates state", async () => {
      const { vault, nft, alice } = await deployFixture();
      await nft.connect(alice).approve(await vault.getAddress(), 1);
      await vault.connect(alice).stake(1);

      const info = await vault.stakes(1);
      expect(info.owner).to.equal(alice.address);
      expect(await vault.totalStaked()).to.equal(1n);
    });

    it("reverts if not NFT owner", async () => {
      const { vault, nft, bob } = await deployFixture();
      await nft.connect(bob).approve(await vault.getAddress(), 6);
      await expect(vault.connect(bob).stake(1))
        .to.be.revertedWithCustomError(vault, "NotTokenOwner");
    });

    it("reverts if already staked", async () => {
      const { vault, nft, alice } = await deployFixture();
      await nft.connect(alice).approve(await vault.getAddress(), 1);
      await vault.connect(alice).stake(1);
      await expect(vault.connect(alice).stake(1))
        .to.be.revertedWithCustomError(vault, "TokenAlreadyStaked");
    });
  });

  describe("Rewards", () => {
    it("accrues rewards over time", async () => {
      const { vault, nft, rewardToken, alice } = await deployFixture();
      await nft.connect(alice).approve(await vault.getAddress(), 1);
      await vault.connect(alice).stake(1);

      await time.increase(3600); // 1 hour

      const pending = await vault.pendingReward(1);
      // 3600 seconds × 1e18 rate × 1x multiplier ≈ 3600e18
      expect(pending).to.be.closeTo(
        ethers.parseEther("3600"),
        ethers.parseEther("1") // 1 second tolerance
      );
    });

    it("2x multiplier doubles rewards", async () => {
      const { vault, nft, owner, alice } = await deployFixture();
      await vault.connect(owner).setMultiplier(1, 20_000); // 2x
      await nft.connect(alice).approve(await vault.getAddress(), 1);
      await vault.connect(alice).stake(1);

      await time.increase(3600);

      const pending = await vault.pendingReward(1);
      expect(pending).to.be.closeTo(
        ethers.parseEther("7200"),
        ethers.parseEther("2")
      );
    });

    it("claimReward mints tokens and resets timer", async () => {
      const { vault, nft, rewardToken, alice } = await deployFixture();
      await nft.connect(alice).approve(await vault.getAddress(), 1);
      await vault.connect(alice).stake(1);

      await time.increase(100);
      await vault.connect(alice).claimReward(1);

      const bal = await rewardToken.balanceOf(alice.address);
      expect(bal).to.be.gt(0n);

      // Pending should reset to near zero
      const pending = await vault.pendingReward(1);
      expect(pending).to.be.lt(ethers.parseEther("2"));
    });

    it("claimAll claims from multiple NFTs", async () => {
      const { vault, nft, rewardToken, alice } = await deployFixture();
      for (let i = 1; i <= 3; i++) {
        await nft.connect(alice).approve(await vault.getAddress(), i);
        await vault.connect(alice).stake(i);
      }

      await time.increase(1000);
      await vault.connect(alice).claimAll();

      const bal = await rewardToken.balanceOf(alice.address);
      // 3 NFTs × 1000s × 1e18 ≈ 3000e18
      expect(bal).to.be.closeTo(ethers.parseEther("3000"), ethers.parseEther("3"));
    });
  });

  describe("Unstaking", () => {
    it("returns NFT and mints rewards on unstake", async () => {
      const { vault, nft, rewardToken, alice } = await deployFixture();
      await nft.connect(alice).approve(await vault.getAddress(), 1);
      await vault.connect(alice).stake(1);
      await time.increase(500);
      await vault.connect(alice).unstake(1);

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await rewardToken.balanceOf(alice.address)).to.be.gt(0n);
      expect(await vault.totalStaked()).to.equal(0n);
    });

    it("removes tokenId from stakedTokensOf", async () => {
      const { vault, nft, alice } = await deployFixture();
      for (let i = 1; i <= 3; i++) {
        await nft.connect(alice).approve(await vault.getAddress(), i);
        await vault.connect(alice).stake(i);
      }
      await vault.connect(alice).unstake(2);

      const staked = await vault.stakedTokensOf(alice.address);
      expect(staked).to.not.include(2n);
      expect(staked.length).to.equal(2);
    });
  });

  describe("Pausable", () => {
    it("blocks stake/claim when paused", async () => {
      const { vault, nft, owner, alice } = await deployFixture();
      await vault.connect(owner).pause();
      await nft.connect(alice).approve(await vault.getAddress(), 1);
      await expect(vault.connect(alice).stake(1))
        .to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
  });
});
