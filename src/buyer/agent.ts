import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { hashOf, randomHex } from "../core/canonical.js";
import { Mutex, withTimeout } from "../core/lock.js";
import { checkBadgeProof, encodeHeader, proveBadge } from "../core/challenge.js";
import { checkMerchantListing, checkPrices, type SignedDirectory } from "../core/directory.js";
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
  DomainVerifier,
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
  /** Verified-merchant directory. The buyer only pays listed merchants, at listed prices. */
  directory: {
    listings: SignedDirectory;
    /** Account of the directory operator this agent trusts. */
    operator: string;
    domains: DomainVerifier;
    /** Mock and local development only. */
    allowLoopbackEndpoints?: boolean;
  };
  /** How long to wait for the owner's answer before treating it as "no". Default 10 minutes. */
  approvalTimeoutMs?: number;
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

  /**
   * Spend reservations. When the mandate allows a purchase (or sends it to the owner), its amount is
   * held against the daily limit until it settles (converted into a ledger entry) or is refused,
   * declined or times out (released). Purchases run in parallel; one waiting for the owner does not
   * block others, but its amount counts while it waits. If the outcome of a pay request is unknown
   * (network error), the hold is kept for the rest of the UTC day: the payment may have gone through.
   */
  private readonly reservations = new Map<string, { amount: bigint; asset: string; day: string }>();
  /** Held only while reading spend and placing a reservation (no I/O inside). */
  private readonly reserveLock = new Mutex();
  /**
   * Held from signing the spend statement until the payment is settled or refused, so payments settle
   * one at a time and each statement includes every payment that settled before it. Never held while
   * waiting for the owner.
   */
  private readonly payLock = new Mutex();

  /** Amount held for purchases in progress today (excluding `except`). */
  reservedToday(except?: string): bigint {
    const day = utcDay();
    let sum = 0n;
    for (const [id, r] of this.reservations) if (id !== except && r.day === day && r.asset === this.mandate.asset) sum += r.amount;
    return sum;
  }

  async purchase(merchantUrl: string, items: { sku: string; qty: number }[]): Promise<PurchaseOutcome> {
    const hold: Hold = { keep: false };
    try {
      return await this.purchaseNow(merchantUrl, items, hold);
    } finally {
      if (hold.id && !hold.keep) this.reservations.delete(hold.id);
    }
  }

  private async purchaseNow(merchantUrl: string, items: { sku: string; qty: number }[], hold: Hold): Promise<PurchaseOutcome> {
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
    // Directory: badge, brand, domain and endpoint bound together; then listed price vs asked price.
    const d = this.cfg.directory;
    const listed = await checkMerchantListing(
      d.listings,
      d.operator,
      { badge: offer.merchant.badge, name: offer.merchant.name, domain: offer.merchant.domain, contactedUrl: merchantUrl },
      { registry: this.cfg.registry, verifier: this.cfg.verifier, domains: d.domains, allowLoopbackEndpoints: d.allowLoopbackEndpoints },
    );
    merchantIssues.push(...listed.issues);
    if (listed.listing) merchantIssues.push(...checkPrices(offer.order, listed.listing, items));
    const merchantOk = merchant.verified && merchantIssues.length === 0;
    ledger.append({ type: "counterparty_check", actor: badge, orderId, data: { ...summarizeVerdict(merchant, merchantOk, merchantIssues), brand: listed.listing?.brand, domain: listed.listing?.domain } });

    // 3. Mandate, against settled spend plus everything held by purchases in progress; reserve.
    const amount = BigInt(req.amount);
    const intent = {
      merchant: { badge: merchant.badge, verified: merchantOk, business: merchant.ownerKind === "business" },
      asset: req.asset,
      amount,
      categories: offer.order.categories,
      description: offer.order.lines.map((l) => `${l.qty}x ${l.name}`).join(", "),
    };
    const evaluation = await this.reserveLock.run(() => {
      const ev = evaluateMandate(this.mandate, intent, this.spentToday() + this.reservedToday());
      if (ev.decision !== "deny") {
        this.reservations.set(orderId, { amount, asset: this.mandate.asset, day: utcDay() });
        hold.id = orderId;
      }
      return ev;
    });
    ledger.append({ type: "mandate_check", actor: badge, orderId, data: { decision: evaluation.decision, reasons: evaluation.reasons, mandate: this.mandateHash, spentToday: evaluation.spentToday, projected: evaluation.projectedToday, reserved: evaluation.decision !== "deny" } });
    if (evaluation.decision === "deny") {
      const reasons = merchantOk ? evaluation.reasons : [...evaluation.reasons, ...merchantIssues.filter((i) => !evaluation.reasons.includes(i))];
      return { status: "denied", stage: merchantOk ? "mandate" : "merchant", reasons, evaluation };
    }

    // 4. Owner consent when outside the mandate (no lock held while waiting).
    const askOwner = async (reasons: string[]): Promise<ConsentResult | PurchaseOutcome> => {
      const creq = {
        orderId,
        orderHash: offer.orderHash,
        agent: badge,
        owner: this.mandate.owner,
        merchantBadge: merchant.badge,
        merchantName: offer.merchant.name,
        amount,
        asset: req.asset,
        summary: intent.description,
        reasons,
      };
      ledger.append({ type: "consent_requested", actor: badge, orderId, data: { reasons } });
      const answer = await withTimeout(this.cfg.consent.request(creq), this.cfg.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
      if (!answer) {
        ledger.append({ type: "consent_result", actor: badge, orderId, data: { approved: false, method: "timeout" } });
        return { status: "denied", stage: "consent", reasons: ["approval_timeout", ...reasons], evaluation };
      }
      ledger.append({ type: "consent_result", actor: badge, orderId, data: { approved: answer.approved, method: answer.method, textHash: answer.textHash, requestAnchorTx: answer.requestAnchorTx, auditAnchorTx: answer.auditAnchorTx } });
      if (!answer.approved) return { status: "denied", stage: "consent", reasons: ["owner_declined", ...reasons], evaluation };
      return answer;
    };
    let consent: ConsentResult | undefined;
    if (evaluation.decision === "consent") {
      const r = await askOwner(evaluation.reasons);
      if ("status" in r) return r;
      consent = r;
    }

    // 5. Prove our badge and any required attributes, sign the payment.
    const proof = await proveBadge(badge, this.cfg.prover, offer.challenge);
    const attest: AttributeProof[] = [];
    if (offer.requires.ageOver) {
      if (!this.cfg.attributes) return { status: "denied", stage: "seller", reasons: ["age_proof_required_but_no_prover"], evaluation };
      attest.push(await this.cfg.attributes.prove("age_over", offer.requires.ageOver, offer.challenge.nonce, offer.requires.ageRequest));
    }
    const payment = await this.cfg.rail.createPayment(req);
    ledger.append({ type: "payment_signed", actor: badge, orderId, data: { amount: req.amount, asset: req.asset, payTo: req.payTo, network: req.network } });

    // 6. Pay. Under the payment lock: state spend-so-far as what has settled (truthful, and never below
    // what any merchant has received, since every payment of this agent settles under this lock), re-check
    // the mandate with that figure exactly as the merchant will, send, and convert the hold on settlement.
    // If a purchase that started later settled first and pushed this one outside the mandate, release the
    // lock, ask the owner, and try once more. Holds of purchases still in progress are not counted here:
    // each of them already counted this one when it reserved.
    type Attempt = { kind: "needs_approval"; reasons: string[] } | { kind: "done"; outcome: PurchaseOutcome };
    const attempt = (): Promise<Attempt> =>
      this.payLock.run(async (): Promise<Attempt> => {
        const spentBefore = this.spentToday();
        const now = evaluateMandate(this.mandate, intent, spentBefore);
        if (now.decision === "deny") return { kind: "done", outcome: { status: "denied", stage: "mandate", reasons: now.reasons, evaluation: now } };
        if (now.decision === "consent" && !consent) return { kind: "needs_approval", reasons: now.reasons };
        const spend = await signSpend({ agent: badge, asset: this.mandate.asset, day: utcDay(), spent: spentBefore.toString(), orderHash: offer.orderHash }, this.cfg.prover);
        const mandateHeader: MandateHeader = { mandate: this.cfg.mandate, spend };
        let payRes: Response;
        try {
          payRes = await this.f(new URL(`/orders/${orderId}/pay`, merchantUrl), {
            method: "POST",
            headers: {
              [H.paymentSignature]: encodePaymentSignatureHeader(payment),
              [H.proof]: encodeHeader(proof),
              [H.attest]: encodeHeader(attest),
              [H.mandate]: encodeHeader(mandateHeader),
              ...(consent ? { [H.consent]: encodeHeader(consent) } : {}),
            },
          });
        } catch (e) {
          hold.keep = true;
          ledger.append({ type: "payment_rejected", actor: badge, orderId, data: { reasons: ["payment_outcome_unknown"], error: String((e as Error).message).slice(0, 120) } });
          return { kind: "done", outcome: { status: "denied", stage: "seller", reasons: ["payment_outcome_unknown"], evaluation: now } };
        }
        if (payRes.status !== 200) {
          const body = await payRes.json().catch(() => ({}));
          const reasons = (body as { reasons?: string[] }).reasons ?? [`status_${payRes.status}`];
          ledger.append({ type: "payment_rejected", actor: badge, orderId, data: { reasons } });
          return { kind: "done", outcome: { status: "denied", stage: "seller", reasons, evaluation: now } };
        }
        const settle = decodePaymentResponseHeader(payRes.headers.get(H.paymentResponse) ?? "");
        const receipt = (await payRes.json()) as Receipt;
        // Convert the hold: the settled entry and the removal happen together (no await in between).
        ledger.append({ type: "payment_settled", actor: badge, orderId, data: { amount: req.amount, asset: req.asset, txHash: settle.transaction, network: settle.network, merchant: merchant.badge } });
        this.reservations.delete(orderId);
        hold.id = undefined;
        // Money has moved, so this cannot undo the purchase; it records whether the receipt is usable evidence.
        const receiptIssues: string[] = [];
        if (!(await verifySigned(this.cfg.verifier, receipt.merchantSignature, "signet-receipt", receiptBody(receipt), [merchant.owner, merchant.agentWallet]))) receiptIssues.push("bad_merchant_signature");
        if (receipt.orderHash !== offer.orderHash || receipt.orderId !== orderId) receiptIssues.push("order_mismatch");
        if (receipt.paid !== req.amount || receipt.asset !== req.asset || receipt.payTo !== req.payTo) receiptIssues.push("terms_mismatch");
        if (receipt.txHash !== settle.transaction) receiptIssues.push("tx_mismatch");
        if (receipt.buyer !== badge || receipt.payer !== this.cfg.prover.account) receiptIssues.push("buyer_mismatch");
        ledger.append({ type: "delivery", actor: badge, orderId, data: { receiptHash: hashOf(receipt), receiptOk: receiptIssues.length === 0, receiptIssues }, privateRecord: receipt });
        return { kind: "done", outcome: { status: "paid", receipt, evaluation: now, consent } };
      });

    let result = await attempt();
    if (result.kind === "needs_approval") {
      const r = await askOwner(result.reasons);
      if ("status" in r) return r;
      consent = r;
      result = await attempt();
    }
    return result.kind === "done" ? result.outcome : { status: "denied", stage: "consent", reasons: ["approval_required"], evaluation };
  }
}

interface Hold {
  id?: string;
  keep: boolean;
}

/** Spec: no answer from the owner in 10 minutes means no. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** Fetches a receipt's inclusion proof from the merchant; undefined while its batch is not anchored yet. */
export async function fetchReceiptProof(merchantUrl: string, orderId: string, f: typeof fetch = fetch): Promise<ReceiptProof | undefined> {
  const r = await f(new URL(`/receipts/${encodeURIComponent(orderId)}`, merchantUrl));
  return r.status === 200 ? ((await r.json()) as ReceiptProof) : undefined;
}

export function summarizeVerdict(v: BadgeVerdict, ok: boolean, issues: string[]) {
  return { badge: v.badge, ok, active: v.active, cardHashMatches: v.cardHashMatches, ownerKind: v.ownerKind, identityProvider: v.identityProvider, issues };
}
