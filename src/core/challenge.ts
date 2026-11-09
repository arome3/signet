import { canonicalJson, randomHex } from "./canonical.js";
import type { AccountProver, AccountVerifier } from "./types.js";

/**
 * Proof-of-control for a badge. A badge string on its own is just a claim anyone can copy.
 * Signet requires the presenting agent to sign a fresh, audience-bound challenge with the key of
 * the account the registry names (the agent's own account, its agentWallet, or the owner).
 */
export interface Challenge {
  v: 2;
  purpose: "signet-proof";
  /** Who is asking (merchant badge or domain). Prevents replay at another merchant. */
  audience: string;
  /**
   * The merchant's id for this quote-and-pay exchange. Both directions (merchant proof and buyer
   * proof) carry the same session, and the merchant accepts each session for one payment only.
   */
  session: string;
  nonce: string;
  /** Binds the proof to exactly this order. */
  orderHash: string;
  exp: number;
}

export const CHALLENGE_TTL_SECONDS = 300;

export function newChallenge(audience: string, orderHash: string, opts: { session?: string; nonce?: string; ttlSeconds?: number } = {}): Challenge {
  return {
    v: 2,
    purpose: "signet-proof",
    audience,
    session: opts.session ?? "ses_" + randomHex(16),
    nonce: opts.nonce ?? randomHex(16),
    orderHash,
    exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? CHALLENGE_TTL_SECONDS),
  };
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
  expected: { audience: string; orderHash: string; nonce: string; session: string },
  allowedAccounts: (string | undefined)[],
  verifier: AccountVerifier,
): Promise<string[]> {
  const issues: string[] = [];
  const c = p?.challenge;
  if (!c || typeof p.account !== "string") return ["bad_proof_format"];
  if (c.purpose !== "signet-proof" || c.v !== 2) issues.push("bad_challenge_format");
  if (c.audience !== expected.audience) issues.push("wrong_audience");
  if (c.session !== expected.session) issues.push("session_mismatch");
  if (c.nonce !== expected.nonce) issues.push("nonce_mismatch");
  if (c.orderHash !== expected.orderHash) issues.push("order_mismatch");
  if (!(c.exp >= Math.floor(Date.now() / 1000))) issues.push("challenge_expired");
  if (!allowedAccounts.filter(Boolean).includes(p.account)) issues.push("account_not_bound_to_badge");
  const sigOk = await verifier.verify(p.account, challengeMessage(c), p.signature).catch(() => false);
  if (!sigOk) issues.push("bad_signature");
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
