import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { type Challenge, encodeHeader, proveBadge } from "../src/core/challenge.js";
import { type SignedMandate, type SignedSpend, signSpend, utcDay } from "../src/core/mandate.js";
import { H, type MandateHeader, type SignetOffer } from "../src/core/protocol.js";
import type { ConsentResult } from "../src/core/types.js";
import type { Scenario } from "../demo/scenario.js";

/**
 * Plays a buyer runtime that talks the wire protocol directly, skipping SignetBuyer's own checks:
 * the "compromised buyer runtime" from the threat model. Every field can be overridden.
 */
export async function quote(s: Scenario, items = [{ sku: "bread", qty: 1 }], opts: { badge?: string; nonce?: string; url?: string } = {}) {
  const r = await fetch(new URL("/orders", opts.url ?? s.shopUrl), {
    method: "POST",
    headers: { "content-type": "application/json", [H.agent]: opts.badge ?? s.kitBadge, [H.nonce]: opts.nonce ?? "n1" },
    body: JSON.stringify({ items }),
  });
  const pr = decodePaymentRequiredHeader(r.headers.get(H.paymentRequired)!);
  return { offer: pr.extensions!.signet as SignetOffer, req: pr.accepts[0] as PaymentRequirements };
}

export interface CraftOpts {
  badge?: string;
  /** Account that signs the badge proof and the spend statement. */
  account?: string;
  /** Account that signs the payment. */
  payer?: string;
  /** `null` sends no mandate header at all. */
  mandate?: SignedMandate | null;
  spent?: bigint;
  spend?: SignedSpend;
  consent?: ConsentResult;
  attest?: unknown[];
  /** Sign this challenge instead of the one in the offer. */
  challenge?: Challenge;
  /** Reuse an existing signed payment instead of creating one. */
  payment?: Awaited<ReturnType<ReturnType<Scenario["world"]["rail"]>["createPayment"]>>;
}

export async function craftPay(s: Scenario, q: { offer: SignetOffer; req: PaymentRequirements }, o: CraftOpts = {}) {
  const account = o.account ?? s.kitAccount.address;
  const badge = o.badge ?? s.kitBadge;
  const proof = await proveBadge(badge, s.world.prover(account), o.challenge ?? q.offer.challenge);
  const payment = o.payment ?? (await s.world.rail(o.payer ?? account).createPayment(q.req));
  const headers: Record<string, string> = {
    [H.paymentSignature]: encodePaymentSignatureHeader(payment),
    [H.proof]: encodeHeader(proof),
    [H.attest]: encodeHeader(o.attest ?? []),
  };
  if (o.mandate !== null) {
    const spend =
      o.spend ??
      (await signSpend({ agent: badge, asset: "USDR", day: utcDay(), spent: (o.spent ?? s.kit.spentToday()).toString(), orderHash: q.offer.orderHash }, s.world.prover(account)));
    const mh: MandateHeader = { mandate: o.mandate ?? s.signedMandate, spend };
    headers[H.mandate] = encodeHeader(mh);
  }
  if (o.consent) headers[H.consent] = encodeHeader(o.consent);
  return { headers, payment };
}

export async function post(s: Scenario, orderId: string, headers: Record<string, string>) {
  const r = await fetch(new URL(`/orders/${orderId}/pay`, s.shopUrl), { method: "POST", headers });
  return { status: r.status, body: (await r.json()) as any };
}
