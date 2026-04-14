// StakingDashboard.tsx
// React/ethers.js frontend for NFTStakingVault
// Install: npm i ethers wagmi @tanstack/react-query

import React, { useEffect, useState, useCallback } from "react";
import { ethers, Contract, BrowserProvider } from "ethers";

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const VAULT_ABI = [
  "function stake(uint256 tokenId) nonpayable",
  "function unstake(uint256 tokenId) nonpayable",
  "function claimReward(uint256 tokenId) nonpayable",
  "function claimAll() nonpayable",
  "function stakedTokensOf(address user) view returns (uint256[])",
  "function pendingReward(uint256 tokenId) view returns (uint256)",
  "function totalPendingRewards(address user) view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function stakes(uint256) view returns (address owner, uint256 stakedAt, uint256 lastClaimed)",
];

const ERC721_ABI = [
  "function approve(address to, uint256 tokenId) nonpayable",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved) nonpayable",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

// ─── Config — update these ────────────────────────────────────────────────────

const VAULT_ADDRESS    = process.env.REACT_APP_VAULT_ADDRESS  || "";
const NFT_ADDRESS      = process.env.REACT_APP_NFT_ADDRESS    || "";
const REWARD_ADDRESS   = process.env.REACT_APP_REWARD_ADDRESS || "";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StakedToken {
  tokenId: bigint;
  pendingReward: bigint;
  stakedAt: bigint;
}

// ─── Hook: wallet ─────────────────────────────────────────────────────────────

function useWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [provider, setProvider] = useState<BrowserProvider | null>(null);

  const connect = useCallback(async () => {
    if (!window.ethereum) { alert("Install MetaMask"); return; }
    const p = new BrowserProvider(window.ethereum);
    await p.send("eth_requestAccounts", []);
    const signer = await p.getSigner();
    setProvider(p);
    setAddress(await signer.getAddress());
  }, []);

  return { address, provider, connect };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function StakingDashboard() {
  const { address, provider, connect } = useWallet();

  const [unstakedTokens, setUnstakedTokens]   = useState<bigint[]>([]);
  const [stakedTokens, setStakedTokens]       = useState<StakedToken[]>([]);
  const [rewardBalance, setRewardBalance]     = useState<bigint>(0n);
  const [totalPending, setTotalPending]       = useState<bigint>(0n);
  const [globalStaked, setGlobalStaked]       = useState<bigint>(0n);
  const [loading, setLoading]                 = useState(false);
  const [txStatus, setTxStatus]               = useState("");

  // ── Load data ───────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!provider || !address) return;
    const signer = await provider.getSigner();

    const vault  = new Contract(VAULT_ADDRESS,  VAULT_ABI,  signer);
    const nft    = new Contract(NFT_ADDRESS,    ERC721_ABI, signer);
    const reward = new Contract(REWARD_ADDRESS, ERC20_ABI,  signer);

    // Unstaked tokens owned by user
    const balance: bigint = await nft.balanceOf(address);
    const unstaked: bigint[] = [];
    for (let i = 0n; i < balance; i++) {
      const id: bigint = await nft.tokenOfOwnerByIndex(address, i);
      unstaked.push(id);
    }
    setUnstakedTokens(unstaked);

    // Staked tokens
    const stakedIds: bigint[] = await vault.stakedTokensOf(address);
    const staked: StakedToken[] = await Promise.all(
      stakedIds.map(async (id) => {
        const pending = await vault.pendingReward(id);
        const info    = await vault.stakes(id);
        return { tokenId: id, pendingReward: pending, stakedAt: info.stakedAt };
      })
    );
    setStakedTokens(staked);

    // Balances
    setRewardBalance(await reward.balanceOf(address));
    setTotalPending(await vault.totalPendingRewards(address));
    setGlobalStaked(await vault.totalStaked());
  }, [provider, address]);

  useEffect(() => { load(); }, [load]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const tx = useCallback(async (fn: () => Promise<any>, label: string) => {
    setLoading(true);
    setTxStatus(`${label}...`);
    try {
      const t = await fn();
      setTxStatus(`Waiting for ${label}...`);
      await t.wait();
      setTxStatus(`✅ ${label} confirmed`);
      await load();
    } catch (e: any) {
      setTxStatus(`❌ ${label} failed: ${e.message?.slice(0, 80)}`);
    } finally {
      setLoading(false);
    }
  }, [load]);

  const handleStake = async (tokenId: bigint) => {
    if (!provider) return;
    const signer = await provider.getSigner();
    const vault  = new Contract(VAULT_ADDRESS, VAULT_ABI,  signer);
    const nft    = new Contract(NFT_ADDRESS,   ERC721_ABI, signer);

    const approved = await nft.isApprovedForAll(address, VAULT_ADDRESS);
    if (!approved) {
      await tx(() => nft.setApprovalForAll(VAULT_ADDRESS, true), "ApproveAll");
    }
    await tx(() => vault.stake(tokenId), `Stake #${tokenId}`);
  };

  const handleUnstake = async (tokenId: bigint) => {
    if (!provider) return;
    const signer = await provider.getSigner();
    const vault  = new Contract(VAULT_ADDRESS, VAULT_ABI, signer);
    await tx(() => vault.unstake(tokenId), `Unstake #${tokenId}`);
  };

  const handleClaim = async (tokenId: bigint) => {
    if (!provider) return;
    const signer = await provider.getSigner();
    const vault  = new Contract(VAULT_ADDRESS, VAULT_ABI, signer);
    await tx(() => vault.claimReward(tokenId), `Claim #${tokenId}`);
  };

  const handleClaimAll = async () => {
    if (!provider) return;
    const signer = await provider.getSigner();
    const vault  = new Contract(VAULT_ADDRESS, VAULT_ABI, signer);
    await tx(() => vault.claimAll(), "Claim All");
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!address) {
    return (
      <div style={styles.center}>
        <h1>🏦 NFT Staking Vault</h1>
        <button style={styles.btn} onClick={connect}>Connect Wallet</button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1>🏦 NFT Staking Vault</h1>
      <p style={styles.addr}>{address.slice(0, 6)}…{address.slice(-4)}</p>

      {/* Stats bar */}
      <div style={styles.stats}>
        <Stat label="Your vRWD Balance"  value={fmt(rewardBalance)} />
        <Stat label="Pending Rewards"    value={fmt(totalPending)} />
        <Stat label="Your NFTs Staked"   value={stakedTokens.length.toString()} />
        <Stat label="Global Staked"      value={globalStaked.toString()} />
      </div>

      {txStatus && <p style={styles.status}>{txStatus}</p>}

      {/* Staked tokens */}
      <section>
        <div style={styles.sectionHeader}>
          <h2>Staked NFTs</h2>
          {stakedTokens.length > 0 && (
            <button style={styles.btn} onClick={handleClaimAll} disabled={loading}>
              Claim All ({fmt(totalPending)} vRWD)
            </button>
          )}
        </div>
        {stakedTokens.length === 0
          ? <p style={styles.empty}>No NFTs staked yet.</p>
          : stakedTokens.map((t) => (
            <TokenCard key={t.tokenId.toString()} token={t}
              onUnstake={() => handleUnstake(t.tokenId)}
              onClaim={() => handleClaim(t.tokenId)}
              disabled={loading}
            />
          ))
        }
      </section>

      {/* Wallet tokens */}
      <section>
        <h2>Your Wallet</h2>
        {unstakedTokens.length === 0
          ? <p style={styles.empty}>No NFTs in wallet.</p>
          : unstakedTokens.map((id) => (
            <div key={id.toString()} style={styles.card}>
              <span>NFT #{id.toString()}</span>
              <button style={styles.btnSm} onClick={() => handleStake(id)} disabled={loading}>
                Stake
              </button>
            </div>
          ))
        }
      </section>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.statBox}>
      <div style={styles.statValue}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

function TokenCard({ token, onUnstake, onClaim, disabled }: {
  token: StakedToken;
  onUnstake: () => void;
  onClaim: () => void;
  disabled: boolean;
}) {
  const stakedDate = new Date(Number(token.stakedAt) * 1000).toLocaleDateString();
  return (
    <div style={styles.card}>
      <div>
        <strong>NFT #{token.tokenId.toString()}</strong>
        <span style={styles.muted}> — Staked {stakedDate}</span>
        <div>{fmt(token.pendingReward)} vRWD pending</div>
      </div>
      <div style={styles.actions}>
        <button style={styles.btnSm} onClick={onClaim}   disabled={disabled}>Claim</button>
        <button style={styles.btnSm} onClick={onUnstake} disabled={disabled}>Unstake</button>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(wei: bigint): string {
  return Number(ethers.formatEther(wei)).toFixed(2);
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container:     { maxWidth: 720, margin: "0 auto", padding: 24, fontFamily: "monospace" },
  center:        { display: "flex", flexDirection: "column", alignItems: "center", marginTop: 100 },
  addr:          { color: "#888", fontSize: 14 },
  stats:         { display: "flex", gap: 16, margin: "24px 0", flexWrap: "wrap" },
  statBox:       { background: "#f5f5f5", borderRadius: 8, padding: "12px 20px", minWidth: 140 },
  statValue:     { fontSize: 22, fontWeight: 700 },
  statLabel:     { fontSize: 12, color: "#666", marginTop: 4 },
  sectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  card:          { display: "flex", justifyContent: "space-between", alignItems: "center",
                   border: "1px solid #eee", borderRadius: 8, padding: "12px 16px", marginBottom: 8 },
  actions:       { display: "flex", gap: 8 },
  btn:           { background: "#000", color: "#fff", border: "none", borderRadius: 6,
                   padding: "10px 20px", cursor: "pointer", fontFamily: "monospace" },
  btnSm:         { background: "#000", color: "#fff", border: "none", borderRadius: 6,
                   padding: "6px 14px", cursor: "pointer", fontFamily: "monospace", fontSize: 12 },
  status:        { padding: "8px 12px", background: "#fffbe6", border: "1px solid #ffe58f",
                   borderRadius: 6, fontFamily: "monospace", fontSize: 13 },
  empty:         { color: "#aaa", fontStyle: "italic" },
  muted:         { color: "#888", fontSize: 13 },
};
