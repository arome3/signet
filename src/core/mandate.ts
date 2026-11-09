import { z } from "zod";
import { hashOf } from "./canonical.js";

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
  /** ISO timestamp after which the mandate is void. */
  validUntil: z.string(),
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

  if (now.getTime() > Date.parse(m.validUntil)) deny.push("mandate_expired");
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
