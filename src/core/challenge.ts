import { canonicalJson, randomHex } from "./canonical.js";
import type { AccountProver, AccountVerifier } from "./types.js";

/**
 * Proof-of-control for a badge. A badge string on its own is just a claim anyone can copy.
 * Signet requires the presenting agent to sign a fresh, audience-bound challenge with the key of
 * the account the registry names (the agent's own account, its agentWallet, or the owner).
 */
export interface Challenge {
  v: 1;
  purpose: "signet-proof";
  /** Who is asking (merchant badge or domain). Prevents replay at another merchant. */
  audience: string;
  nonce: string;
  /** Binds the proof to exactly this order. */
  orderHash: string;
  exp: number;
}

export function newChallenge(audience: string, orderHash: string, ttlSeconds = 300): Challenge {
  return { v: 1, purpose: "signet-proof", audience, nonce: randomHex(16), orderHash, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
}

export function challengeMessage(c: Challenge): string {
  return canonicalJson(c);
}

export interface BadgeProof {
  badge: string;
  account: string;
  challenge: Challenge;
  signature: unknown;
}

export async function proveBadge(badge: string, prover: AccountProver, c: Challenge): Promise<BadgeProof> {
  return { badge, account: prover.account, challenge: c, signature: await prover.sign(challengeMessage(c)) };
}

/**
 * @param allowedAccounts accounts the registry ties to the badge (owner, agentWallet).
 */
export async function checkBadgeProof(
  p: BadgeProof,
  expected: { audience: string; orderHash: string; nonce: string },
  allowedAccounts: (string | undefined)[],
  verifier: AccountVerifier,
): Promise<string[]> {
  const issues: string[] = [];
  const c = p.challenge;
  if (c.purpose !== "signet-proof" || c.v !== 1) issues.push("bad_challenge_format");
  if (c.audience !== expected.audience) issues.push("wrong_audience");
  if (c.nonce !== expected.nonce) issues.push("nonce_mismatch");
  if (c.orderHash !== expected.orderHash) issues.push("order_mismatch");
  if (c.exp < Math.floor(Date.now() / 1000)) issues.push("challenge_expired");
  if (!allowedAccounts.filter(Boolean).includes(p.account)) issues.push("account_not_bound_to_badge");
  if (!(await verifier.verify(p.account, challengeMessage(c), p.signature))) issues.push("bad_signature");
  return issues;
}

export function encodeHeader(v: unknown): string {
  return Buffer.from(canonicalJson(v)).toString("base64url");
}

export function decodeHeader<T>(h: string | undefined): T | undefined {
  if (!h) return undefined;
  try {
    return JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}
