import { z } from "zod";
import { hashOf } from "./canonical.js";
import { type AccountSignature, signAs, verifySigned } from "./signing.js";
import type { AccountProver, AccountVerifier } from "./types.js";

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO date");

/**
 * A Mandate is the owner's signed statement of what their agent may do with money.
 * Its hash is published in the agent's CIS-8004 metadata (key `signet.mandate`), so any
 * counterparty can see the agent's declared limits and check that the agent stayed inside them.
 *
 * Amounts are atomic units of `asset` (e.g. USDR has 6 decimals: 1_000_000 = 1 USDR).
 */
export const MandateSchema = z.object({
  version: z.literal(1),
  /** Badge (CIS-2 token address, Base58Check) of the agent this mandate governs. */
  agent: z.string().min(5),
  /** Concordium account of the accountable owner (human or business). */
  owner: z.string().min(5),
  /** PLT symbol or "CCD". */
  asset: z.string().min(1),
  /** Above this amount for a single payment the owner must consent. */
  perPaymentLimit: z.string().regex(/^\d+$/),
  /** Above this total for the UTC day (including the new payment) the owner must consent. */
  dailyLimit: z.string().regex(/^\d+$/),
  /** Never pay more than this in one payment, even with consent. */
  hardLimit: z.string().regex(/^\d+$/),
  /** If non-empty, only these categories may be bought without consent. */
  allowedCategories: z.array(z.string()).default([]),
  /** Never buy these categories. */
  blockedCategories: z.array(z.string()).default([]),
  /** Always ask the owner before buying these categories. */
  consentCategories: z.array(z.string()).default([]),
  merchantPolicy: z
    .object({
      /** Counterparty must hold an Active Verified-by-Concordium badge with a matching card hash. */
      requireVerifiedBadge: z.boolean().default(true),
      /** Counterparty's owner account must come from a business identity provider. */
      requireBusinessOwner: z.boolean().default(false),
      /** If non-empty, only these merchant badges may be paid. */
      allowlist: z.array(z.string()).default([]),
    })
    .default({}),
  /** ISO timestamp before which the mandate is not yet in force (optional). */
  validFrom: isoDate.optional(),
  /** ISO timestamp after which the mandate is void. */
  validUntil: isoDate,
});

export type Mandate = z.infer<typeof MandateSchema>;

export function parseMandate(input: unknown): Mandate {
  return MandateSchema.parse(input);
}

export function mandateHash(m: Mandate): string {
  return hashOf(m);
}

/** What the agent is about to do, as seen from the buyer side. */
export interface PaymentIntent {
  merchant: {
    badge: string;
    verified: boolean;
    business: boolean;
    domainVerified?: boolean;
  };
  asset: string;
  amount: bigint;
  categories: string[];
  description: string;
}

export type Decision = "allow" | "consent" | "deny";

export interface MandateEvaluation {
  decision: Decision;
  /** Machine-readable reasons, e.g. "daily_limit_exceeded". */
  reasons: string[];
  spentToday: bigint;
  projectedToday: bigint;
}

/**
 * Pure policy check. Deny beats consent beats allow.
 * `spentToday` is the sum of settled payments for the agent in the current UTC day.
 */
export function evaluateMandate(
  m: Mandate,
  intent: PaymentIntent,
  spentToday: bigint,
  now: Date = new Date(),
): MandateEvaluation {
  const deny: string[] = [];
  const consent: string[] = [];
  const projected = spentToday + intent.amount;

  const until = Date.parse(m.validUntil);
  if (Number.isNaN(until) || now.getTime() > until) deny.push("mandate_expired");
  if (m.validFrom !== undefined && !(now.getTime() >= Date.parse(m.validFrom))) deny.push("mandate_not_yet_valid");
  if (intent.asset !== m.asset) deny.push("asset_not_allowed");
  if (intent.amount > BigInt(m.hardLimit)) deny.push("hard_limit_exceeded");

  const mp = m.merchantPolicy;
  if (mp.requireVerifiedBadge && !intent.merchant.verified) deny.push("merchant_not_verified");
  if (mp.requireBusinessOwner && !intent.merchant.business) deny.push("merchant_not_business");
  if (mp.allowlist.length > 0 && !mp.allowlist.includes(intent.merchant.badge)) deny.push("merchant_not_allowlisted");

  for (const c of intent.categories) {
    if (m.blockedCategories.includes(c)) deny.push(`category_blocked:${c}`);
    if (m.consentCategories.includes(c)) consent.push(`category_needs_consent:${c}`);
    if (m.allowedCategories.length > 0 && !m.allowedCategories.includes(c)) consent.push(`category_not_preapproved:${c}`);
  }

  if (intent.amount > BigInt(m.perPaymentLimit)) consent.push("per_payment_limit_exceeded");
  if (projected > BigInt(m.dailyLimit)) consent.push("daily_limit_exceeded");

  if (deny.length) return { decision: "deny", reasons: deny, spentToday, projectedToday: projected };
  if (consent.length) return { decision: "consent", reasons: consent, spentToday, projectedToday: projected };
  return { decision: "allow", reasons: ["within_mandate"], spentToday, projectedToday: projected };
}

export function formatAmount(atomic: bigint | string, decimals = 6, symbol = ""): string {
  const v = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}${symbol ? " " + symbol : ""}`;
}

// ---- Owner signature -------------------------------------------------------------------------

/**
 * A mandate plus the owner's signature over its hash. The agent holds this and shows it to every
 * merchant (header X-SIGNET-MANDATE); the hash alone is published in the badge's CIS-8004 metadata.
 * Changing any limit changes the hash, so the agent cannot raise its own limits.
 */
export interface SignedMandate {
  mandate: Mandate;
  ownerSignature: AccountSignature;
}

export async function signMandate(m: Mandate, owner: AccountProver): Promise<SignedMandate> {
  if (owner.account !== m.owner) throw new Error("only the account named as the mandate's owner can sign it");
  return { mandate: m, ownerSignature: await signAs(owner, "signet-mandate", { mandateHash: mandateHash(m) }) };
}

/**
 * Checks a signed mandate received from anywhere (fail closed: malformed input is an issue, never
 * an exception). `publishedHash` is the `signet.mandate` value from the agent's registry entry; when
 * it is missing the mandate is refused, because nothing ties it to the badge.
 */
export async function checkSignedMandate(
  input: unknown,
  expected: { agent: string; publishedHash: string | undefined },
  verifier: AccountVerifier,
): Promise<{ issues: string[]; mandate?: Mandate; hash?: string }> {
  const sm = input as Partial<SignedMandate> | undefined;
  const parsed = MandateSchema.safeParse(sm?.mandate);
  if (!sm || !parsed.success) return { issues: ["mandate_malformed"] };
  const mandate = parsed.data;
  const hash = mandateHash(mandate);
  const issues: string[] = [];
  if (sm.ownerSignature?.account !== mandate.owner) issues.push("mandate_signer_not_owner");
  else if (!(await verifySigned(verifier, sm.ownerSignature, "signet-mandate", { mandateHash: hash }))) issues.push("mandate_bad_signature");
  if (mandate.agent !== expected.agent) issues.push("mandate_wrong_agent");
  if (!expected.publishedHash) issues.push("mandate_not_published");
  else if (expected.publishedHash !== hash) issues.push("mandate_hash_not_published_value");
  return { issues, mandate, hash };
}

// ---- Spend-so-far statement ------------------------------------------------------------------

/**
 * The agent's signed statement of what it has already paid today, bound to one order. The merchant
 * cannot see the agent's payments at other merchants, so this is an attested figure: the merchant
 * checks it is signed by the agent's proven account, is for today and this order, and is not below
 * what the merchant itself has received from the agent today. A false statement is signed evidence.
 */
export interface SpendStatement {
  agent: string;
  asset: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Atomic units already settled today, before this order. */
  spent: string;
  orderHash: string;
}

export interface SignedSpend {
  statement: SpendStatement;
  signature: AccountSignature;
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export async function signSpend(s: SpendStatement, agentAccount: AccountProver): Promise<SignedSpend> {
  return { statement: s, signature: await signAs(agentAccount, "signet-spend", s) };
}

/** Returns issues, plus the attested amount when the statement is usable. */
export async function checkSpend(
  input: unknown,
  expected: { agent: string; asset: string; orderHash: string; account: string; atLeast: bigint; now?: Date },
  verifier: AccountVerifier,
): Promise<{ issues: string[]; spent?: bigint }> {
  const s = input as Partial<SignedSpend> | undefined;
  const st = s?.statement;
  if (!st || typeof st.spent !== "string" || !/^\d+$/.test(st.spent)) return { issues: ["spend_statement_malformed"] };
  const issues: string[] = [];
  if (st.agent !== expected.agent) issues.push("spend_wrong_agent");
  if (st.asset !== expected.asset) issues.push("spend_wrong_asset");
  if (st.day !== utcDay(expected.now)) issues.push("spend_wrong_day");
  if (st.orderHash !== expected.orderHash) issues.push("spend_wrong_order");
  if (!(await verifySigned(verifier, s.signature, "signet-spend", st, [expected.account]))) issues.push("spend_bad_signature");
  const spent = BigInt(st.spent);
  if (spent < expected.atLeast) issues.push("spend_understated");
  return { issues, spent };
}
