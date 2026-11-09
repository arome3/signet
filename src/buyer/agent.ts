import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { hashOf, randomHex } from "../core/canonical.js";
import { checkBadgeProof, encodeHeader, proveBadge } from "../core/challenge.js";
import { checkSignedMandate, evaluateMandate, type MandateEvaluation, mandateHash, type SignedMandate, signSpend, utcDay } from "../core/mandate.js";
import type { AuditLedger } from "../core/ledger.js";
import { H, type MandateHeader, type Receipt, type ReceiptProof, type SignetOffer } from "../core/protocol.js";
import { receiptBody } from "../core/receipt.js";
import { verifySigned } from "../core/signing.js";
import type {
  AccountProver,
  AccountVerifier,
  AgentRegistry,
  AttributeProof,
  AttributeProver,
  BadgeVerdict,
  ConsentProvider,
  ConsentResult,
  PaymentRail,
} from "../core/types.js";

export interface BuyerConfig {
  badge: string;
  /** The owner-signed mandate. Its hash must be the badge's published `signet.mandate` value. */
  mandate: SignedMandate;
  /** Signs challenges with the account the registry binds to this badge. */
  prover: AccountProver;
  attributes?: AttributeProver;
  rail: PaymentRail;
  registry: AgentRegistry;
  verifier: AccountVerifier;
  consent: ConsentProvider;
  ledger: AuditLedger;
  fetch?: typeof fetch;
}

export type PurchaseOutcome =
  | { status: "paid"; receipt: Receipt; evaluation: MandateEvaluation; consent?: ConsentResult }
  | { status: "denied"; stage: "merchant" | "mandate" | "consent" | "seller"; reasons: string[]; evaluation?: MandateEvaluation };

/**
 * Buyer-side Signet: wraps any agent's purchases so that it only pays verified counterparties,
 * stays inside its owner's mandate (asking the owner when it would not), proves its own badge,
 * and leaves a hash-chained record of every step.
 */
export class SignetBuyer {
  private readonly f: typeof fetch;
  constructor(private readonly cfg: BuyerConfig) {
    this.f = cfg.fetch ?? fetch;
  }

  get mandateHash() {
    return mandateHash(this.cfg.mandate.mandate);
  }

  private get mandate() {
    return this.cfg.mandate.mandate;
  }

  spentToday(): bigint {
    return this.cfg.ledger.spentToday(this.cfg.badge, this.mandate.asset);
  }

  async purchase(merchantUrl: string, items: { sku: string; qty: number }[]): Promise<PurchaseOutcome> {
    const { badge, ledger } = this.cfg;
    const nonce = randomHex(16);

    // 0. Our own mandate must be owner-signed and match what the badge publishes, or we do not shop.
    const own = await this.cfg.registry.check(badge);
    const mandateIssues = (await checkSignedMandate(this.cfg.mandate, { agent: badge, publishedHash: own.mandateHash }, this.cfg.verifier)).issues;
    if (mandateIssues.length) {
      ledger.append({ type: "mandate_check", actor: badge, data: { decision: "deny", reasons: mandateIssues, mandate: this.mandateHash } });
      return { status: "denied", stage: "mandate", reasons: mandateIssues };
    }

    // 1. Ask for an offer.
    const res = await this.f(new URL("/orders", merchantUrl), {
      method: "POST",
      headers: { "content-type": "application/json", [H.nonce]: nonce, [H.agent]: badge },
      body: JSON.stringify({ items }),
    });
    if (res.status !== 402) return { status: "denied", stage: "seller", reasons: [`unexpected_status_${res.status}:${await res.text()}`] };
    const pr: PaymentRequired = decodePaymentRequiredHeader(res.headers.get(H.paymentRequired) ?? "");
    const offer = pr.extensions?.signet as SignetOffer | undefined;
    const req = pr.accepts[0];
    if (!offer || !req) return { status: "denied", stage: "seller", reasons: ["no_signet_offer"] };
    const orderId = offer.order.id;
    ledger.append({ type: "request", actor: badge, orderId, data: { merchant: offer.merchant.badge, total: offer.order.total, asset: offer.order.asset, categories: offer.order.categories }, privateRecord: offer.order });

    // 2. Verify the merchant: registry verdict + proof it controls the badge + offer integrity.
    const merchant = await this.cfg.registry.check(offer.merchant.badge);
    const merchantIssues = [...merchant.issues];
    if (hashOf(offer.order) !== offer.orderHash) merchantIssues.push("order_hash_mismatch");
    if (req.amount !== offer.order.total || req.asset !== offer.order.asset) merchantIssues.push("payment_terms_mismatch");
    if (offer.merchantProof.badge !== offer.merchant.badge) merchantIssues.push("merchant_proof_badge_mismatch");
    // The challenge we are asked to sign must be for this merchant, this session and this order;
    // otherwise we could be made to produce a proof that works somewhere else.
    const c = offer.challenge;
    if (c?.audience !== offer.merchant.badge) merchantIssues.push("challenge_audience_not_merchant");
    if (c?.session !== offer.session) merchantIssues.push("challenge_session_mismatch");
    if (c?.orderHash !== offer.orderHash) merchantIssues.push("challenge_order_mismatch");
    if (!(c?.exp >= Math.floor(Date.now() / 1000))) merchantIssues.push("challenge_expired");
    merchantIssues.push(
      ...(await checkBadgeProof(
        offer.merchantProof,
        { audience: badge, orderHash: offer.orderHash, nonce, session: offer.session },
        [merchant.owner, merchant.agentWallet],
        this.cfg.verifier,
      )),
    );
    if (req.payTo !== merchant.owner && req.payTo !== merchant.agentWallet) merchantIssues.push("payto_not_bound_to_badge");
    const merchantOk = merchant.verified && merchantIssues.length === 0;
    ledger.append({ type: "counterparty_check", actor: badge, orderId, data: summarizeVerdict(merchant, merchantOk, merchantIssues) });

    // 3. Mandate.
    const evaluation = evaluateMandate(
      this.mandate,
      {
        merchant: { badge: merchant.badge, verified: merchantOk, business: merchant.ownerKind === "business" },
        asset: req.asset,
        amount: BigInt(req.amount),
        categories: offer.order.categories,
        description: offer.order.lines.map((l) => `${l.qty}x ${l.name}`).join(", "),
      },
      this.spentToday(),
    );
    ledger.append({ type: "mandate_check", actor: badge, orderId, data: { decision: evaluation.decision, reasons: evaluation.reasons, mandate: this.mandateHash, spentToday: evaluation.spentToday, projected: evaluation.projectedToday } });
    if (evaluation.decision === "deny") return { status: "denied", stage: merchantOk ? "mandate" : "merchant", reasons: evaluation.reasons, evaluation };

    // 4. Owner consent when outside the mandate.
    let consent: ConsentResult | undefined;
    if (evaluation.decision === "consent") {
      const creq = {
        orderId,
        orderHash: offer.orderHash,
        agent: badge,
        owner: this.mandate.owner,
        merchantBadge: merchant.badge,
        merchantName: offer.merchant.name,
        amount: BigInt(req.amount),
        asset: req.asset,
        summary: offer.order.lines.map((l) => `${l.qty}x ${l.name}`).join(", "),
        reasons: evaluation.reasons,
      };
      ledger.append({ type: "consent_requested", actor: badge, orderId, data: { reasons: evaluation.reasons } });
      consent = await this.cfg.consent.request(creq);
      ledger.append({ type: "consent_result", actor: badge, orderId, data: { approved: consent.approved, method: consent.method, textHash: consent.textHash, requestAnchorTx: consent.requestAnchorTx, auditAnchorTx: consent.auditAnchorTx } });
      if (!consent.approved) return { status: "denied", stage: "consent", reasons: ["owner_declined", ...evaluation.reasons], evaluation };
    }

    // 5. Prove our badge and any required attributes, sign the payment.
    const proof = await proveBadge(badge, this.cfg.prover, offer.challenge);
    const attest: AttributeProof[] = [];
    if (offer.requires.ageOver) {
      if (!this.cfg.attributes) return { status: "denied", stage: "seller", reasons: ["age_proof_required_but_no_prover"], evaluation };
      attest.push(await this.cfg.attributes.prove("age_over", offer.requires.ageOver, offer.challenge.nonce, offer.requires.ageRequest));
    }
    const spend = await signSpend({ agent: badge, asset: this.mandate.asset, day: utcDay(), spent: evaluation.spentToday.toString(), orderHash: offer.orderHash }, this.cfg.prover);
    const mandateHeader: MandateHeader = { mandate: this.cfg.mandate, spend };
    const payment = await this.cfg.rail.createPayment(req);
    ledger.append({ type: "payment_signed", actor: badge, orderId, data: { amount: req.amount, asset: req.asset, payTo: req.payTo, network: req.network } });

    const payRes = await this.f(new URL(`/orders/${orderId}/pay`, merchantUrl), {
      method: "POST",
      headers: {
        [H.paymentSignature]: encodePaymentSignatureHeader(payment),
        [H.proof]: encodeHeader(proof),
        [H.attest]: encodeHeader(attest),
        [H.mandate]: encodeHeader(mandateHeader),
        ...(consent ? { [H.consent]: encodeHeader(consent) } : {}),
      },
    });
    if (payRes.status !== 200) {
      const body = await payRes.json().catch(() => ({}));
      const reasons = (body as { reasons?: string[] }).reasons ?? [`status_${payRes.status}`];
      ledger.append({ type: "payment_rejected", actor: badge, orderId, data: { reasons } });
      return { status: "denied", stage: "seller", reasons, evaluation };
    }
    const settle = decodePaymentResponseHeader(payRes.headers.get(H.paymentResponse) ?? "");
    const receipt = (await payRes.json()) as Receipt;
    ledger.append({ type: "payment_settled", actor: badge, orderId, data: { amount: req.amount, asset: req.asset, txHash: settle.transaction, network: settle.network, merchant: merchant.badge } });
    // Money has moved, so this cannot undo the purchase; it records whether the receipt is usable evidence.
    const receiptIssues: string[] = [];
    if (!(await verifySigned(this.cfg.verifier, receipt.merchantSignature, "signet-receipt", receiptBody(receipt), [merchant.owner, merchant.agentWallet]))) receiptIssues.push("bad_merchant_signature");
    if (receipt.orderHash !== offer.orderHash || receipt.orderId !== orderId) receiptIssues.push("order_mismatch");
    if (receipt.paid !== req.amount || receipt.asset !== req.asset || receipt.payTo !== req.payTo) receiptIssues.push("terms_mismatch");
    if (receipt.txHash !== settle.transaction) receiptIssues.push("tx_mismatch");
    if (receipt.buyer !== badge || receipt.payer !== this.cfg.prover.account) receiptIssues.push("buyer_mismatch");
    ledger.append({ type: "delivery", actor: badge, orderId, data: { receiptHash: hashOf(receipt), receiptOk: receiptIssues.length === 0, receiptIssues }, privateRecord: receipt });
    return { status: "paid", receipt, evaluation, consent };
  }
}

/** Fetches a receipt's inclusion proof from the merchant; undefined while its batch is not anchored yet. */
export async function fetchReceiptProof(merchantUrl: string, orderId: string, f: typeof fetch = fetch): Promise<ReceiptProof | undefined> {
  const r = await f(new URL(`/receipts/${encodeURIComponent(orderId)}`, merchantUrl));
  return r.status === 200 ? ((await r.json()) as ReceiptProof) : undefined;
}

export function summarizeVerdict(v: BadgeVerdict, ok: boolean, issues: string[]) {
  return { badge: v.badge, ok, active: v.active, cardHashMatches: v.cardHashMatches, ownerKind: v.ownerKind, identityProvider: v.identityProvider, issues };
}
