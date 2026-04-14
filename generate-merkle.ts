/**
 * generate-merkle.ts
 * Builds a Merkle tree from a whitelist of (tokenId, multiplierBps) pairs
 * and outputs the root + per-token proofs to merkle-output.json.
 *
 * Usage:
 *   npx ts-node scripts/generate-merkle.ts
 */

import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import * as fs from "fs";

// ─── Define your whitelist ────────────────────────────────────────────────────
// Format: [tokenId, multiplierBps]
// 10_000 = 1x, 20_000 = 2x, 15_000 = 1.5x

const WHITELIST: [number, number][] = [
  // Common tier  — 1x
  ...[...Array(100)].map((_, i) => [i + 1,   10_000] as [number, number]),
  // Rare tier    — 1.5x
  ...[...Array(50)].map((_, i)  => [i + 101,  15_000] as [number, number]),
  // Legendary    — 2x
  ...[...Array(10)].map((_, i)  => [i + 151,  20_000] as [number, number]),
];

// ─── Build leaves ─────────────────────────────────────────────────────────────

function encodeLeaf(tokenId: number, multiplierBps: number): Buffer {
  const packed = ethers.solidityPacked(
    ["uint256", "uint256"],
    [tokenId, multiplierBps]
  );
  return Buffer.from(ethers.keccak256(packed).slice(2), "hex");
}

const leaves = WHITELIST.map(([id, bps]) => encodeLeaf(id, bps));
const tree   = new MerkleTree(leaves, ethers.keccak256, { sortPairs: true });
const root   = tree.getHexRoot();

console.log("Merkle Root:", root);

// ─── Build proof map ──────────────────────────────────────────────────────────

const output: Record<string, { multiplierBps: number; proof: string[] }> = {};

for (const [tokenId, multiplierBps] of WHITELIST) {
  const leaf  = encodeLeaf(tokenId, multiplierBps);
  const proof = tree.getHexProof(leaf);
  output[tokenId.toString()] = { multiplierBps, proof };
}

// ─── Write output ─────────────────────────────────────────────────────────────

const result = { root, proofs: output };
fs.writeFileSync("merkle-output.json", JSON.stringify(result, null, 2));

console.log(`Generated proofs for ${WHITELIST.length} tokens → merkle-output.json`);
console.log(`Tree depth: ${tree.getDepth()}`);
