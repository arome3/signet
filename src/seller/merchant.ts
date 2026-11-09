import express, { type Request, type Response } from "express";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { hashOf, randomHex } from "../core/canonical.js";
import { orderMemo } from "../core/memo.js";
import { type BadgeProof, type Challenge, checkBadgeProof, decodeHeader, newChallenge, proveBadge } from "../core/challenge.js";
import { checkApproval } from "../core/consent.js";
import type { Listing } from "../core/directory.js";
import type { AuditLedger } from "../core/ledger.js";
import { checkSignedMandate, checkSpend, evaluateMandate, type MandateEvaluation } from "../core/mandate.js";
import { H, type MandateHeader, type Order, type OrderLine, type Receipt, type SignetOffer } from "../core/protocol.js";
import { buildReceiptProof, signReceipt } from "../core/receipt.js";
import { MerchantStore } from "./store.js";
import type { AccountProver, AccountVerifier, AgentRegistry, AttributeProof, AttributeVerifier, ConsentResult, PaymentRail } from "../core/types.js";

export interface CatalogItem {
  sku: string;
  name: string;
  unitPrice: bigint;
  category: string;
  /** Minimum age of the buyer's accountable owner. */
  ageRestricted?: number;
}

/** The merchant's directory listing for its catalog (sign it with signListing). */
export function catalogListing(m: { badge: string; name: string; domain: string; asset: string; catalog: CatalogItem[] }, endpoint: string): Listing {
  return {
    v: 1,
    badge: m.badge,
    brand: m.name,
    domain: m.domain,
    endpoint,
    asset: m.asset,
    items: m.catalog.map((c) => ({ sku: c.sku, name: c.name, unitPrice: c.unitPrice.toString(), category: c.category })),
    issuedAt: new Date().toISOString(),
  };
}

export interface SellerPolicy {
  /** Only serve agents whose badge owner was issued by an agent identity provider (Agent IDP). */
  requireAgentAccount: boolean;
  /** Accept buyers whose owner is a plain human/business account (cross-chain or classic badges). */
  allowHumanBackedAgents: boolean;
}

export interface SellerConfig {
  name: string;
  domain?: string;
  badge: string;
  /** Account that receives funds; must be the badge owner or its agentWallet. */
  payTo: string;
  asset: string;
  catalog: CatalogItem[];
  prover: AccountProver;
  rail: PaymentRail;
  registry: AgentRegistry;
  verifier: AccountVerifier;
  attributes: AttributeVerifier;
  ledger: AuditLedger;
  policy?: Partial<SellerPolicy>;
  /**
   * JSON file for order state, used payment signatures and spend received per agent (e.g.
   * out/merchant-state.json). Without it, state is in memory and a restart forgets paid orders.
   */
  stateFile?: string;
  /** Live mode: create and anchor a Verify & Access request for "owner is at least N". */
  makeAgeRequest?: (threshold: number, orderHash: string) => Promise<unknown>;
}

/**
 * Seller-side Signet as an Express app: quotes orders over x402, refuses agents that cannot prove
 * an accountable owner, checks age-restricted baskets with zero-knowledge attribute proofs, and
 * settles through the facilitator (sponsored Concordium transaction, so buyers never hold CCD).
 */
export function createMerchantApp(cfg: SellerConfig) {
  const policy: SellerPolicy = { requireAgentAccount: false, allowHumanBackedAgents: true, ...cfg.policy };
  /** Orders, used payment signatures and spend received per agent; persisted when cfg.stateFile is set. */
  const store = new MerchantStore(cfg.stateFile);
  const pending = store.orders;
  const app = express();
  app.use(express.json());

  const reject = (res: Response, status: number, reasons: string[], orderId?: string, actor = cfg.badge) => {
    cfg.ledger.append({ type: "payment_rejected", actor, orderId, data: { reasons, by: cfg.badge } });
    res.status(status).json({ error: "signet_rejected", reasons });
  };

  app.get("/.well-known/signet", (_req, res) => {
    res.json({ merchant: cfg.name, badge: cfg.badge, asset: cfg.asset, network: cfg.rail.network, catalog: cfg.catalog.map((c) => ({ ...c, unitPrice: c.unitPrice.toString() })) });
  });

  /** Async handlers that throw become logged refusals (fail closed), never hung requests. */
  const guarded = (h: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      await h(req, res);
    } catch {
      const p = pending.get(String(req.params.id ?? ""));
      if (p?.state === "in_flight") {
        p.state = "rejected";
        store.save();
      }
      if (!res.headersSent) reject(res, 500, ["internal_error"], p?.order.id);
      else cfg.ledger.append({ type: "payment_rejected", actor: cfg.badge, orderId: p?.order.id, data: { reasons: ["internal_error_after_response"], by: cfg.badge } });
    }
  };

  app.post("/orders", guarded(async (req: Request, res: Response) => {
    const buyerBadge = req.header(H.agent);
    const buyerNonce = req.header(H.nonce);
    if (!buyerBadge || !buyerNonce) return reject(res, 401, ["missing_agent_badge_or_nonce"]);

    // Gate before quoting: unaccountable agents are never asked to pay.
    const verdict = await cfg.registry.check(buyerBadge);
    const issues = [...verdict.issues];
    if (!verdict.verified) issues.push("buyer_not_verified");
    if (policy.requireAgentAccount && verdict.ownerKind !== "agent") issues.push("buyer_not_agent_account");
    if (!policy.allowHumanBackedAgents && verdict.ownerKind !== "agent") issues.push("human_backed_agents_not_accepted");
    cfg.ledger.append({ type: "counterparty_check", actor: cfg.badge, data: { badge: buyerBadge, ok: issues.length === 0, ownerKind: verdict.ownerKind, identityProvider: verdict.identityProvider, issues } });
    if (issues.length) return reject(res, 403, issues);

    const items = (req.body?.items ?? []) as { sku: string; qty: number }[];
    const lines: OrderLine[] = [];
    let total = 0n;
    let ageOver: number | undefined;
    for (const it of items) {
      const c = cfg.catalog.find((x) => x.sku === it.sku);
      if (!c || !Number.isInteger(it.qty) || it.qty < 1) return reject(res, 400, [`bad_item:${it.sku}`]);
      lines.push({ sku: c.sku, name: c.name, qty: it.qty, unitPrice: c.unitPrice.toString(), category: c.category });
      total += c.unitPrice * BigInt(it.qty);
      if (c.ageRestricted) ageOver = Math.max(ageOver ?? 0, c.ageRestricted);
    }
    if (!lines.length) return reject(res, 400, ["empty_order"]);

    const order: Order = {
      id: "ord_" + randomHex(6),
      merchant: cfg.badge,
      lines,
      total: total.toString(),
      asset: cfg.asset,
      categories: [...new Set(lines.map((l) => l.category))],
      createdAt: new Date().toISOString(),
    };
    const orderHash = hashOf(order);
    const session = "ses_" + randomHex(16);
    const challenge = newChallenge(cfg.badge, orderHash, { session });
    const merchantProof: BadgeProof = await proveBadge(cfg.badge, cfg.prover, newChallenge(buyerBadge, orderHash, { session, nonce: buyerNonce, ttlSeconds: 300 }));
    const requirements = await cfg.rail.requirements({ payTo: cfg.payTo, asset: cfg.asset, amount: total, memo: orderMemo(orderHash) });
    const ageRequest = ageOver && cfg.makeAgeRequest ? await cfg.makeAgeRequest(ageOver, orderHash) : undefined;
    pending.set(order.id, { state: "quoted", order, orderHash, session, challenge, requirements, buyerBadge, ageOver, ageRequest });
    store.save();

    const offer: SignetOffer = {
      merchant: { badge: cfg.badge, name: cfg.name, domain: cfg.domain },
      order,
      orderHash,
      session,
      merchantProof,
      challenge,
      requires: { ageOver, ageRequest, agentAccount: policy.requireAgentAccount },
    };
    const pr: PaymentRequired = {
      x402Version: 2,
      resource: { url: `/orders/${order.id}/pay`, description: `${cfg.name} order ${order.id}`, mimeType: "application/json" },
      accepts: [requirements],
      extensions: { signet: offer },
    };
    cfg.ledger.append({ type: "request", actor: cfg.badge, orderId: order.id, data: { buyer: buyerBadge, session, total: order.total, asset: order.asset, categories: order.categories, ageOver }, privateRecord: order });
    res.status(402).setHeader(H.paymentRequired, encodePaymentRequiredHeader(pr)).json({ error: "payment_required", orderId: order.id });
  }));

  app.post("/orders/:id/pay", guarded(async (req: Request, res: Response) => {
    const p = pending.get(req.params.id);
    if (!p) return reject(res, 404, ["unknown_order"]);
    const orderId = p.order.id;
    if (p.state !== "quoted") return reject(res, 409, [p.state === "paid" ? "order_already_paid" : "order_already_used"], orderId);
    // Claim the order before the first await (and on disk): a concurrent or post-restart request sees in_flight.
    p.state = "in_flight";
    store.save();
    const refuse = (status: number, reasons: string[], actor?: string) => {
      p.state = "rejected";
      store.save();
      return reject(res, status, reasons, orderId, actor);
    };
    if (!(p.challenge.exp >= Math.floor(Date.now() / 1000))) return refuse(410, ["order_expired"]);

    const proof = decodeHeader<BadgeProof>(req.header(H.proof));
    const attest = decodeHeader<AttributeProof[]>(req.header(H.attest)) ?? [];
    const consent = decodeHeader<ConsentResult>(req.header(H.consent));
    const sigHeader = req.header(H.paymentSignature);
    if (!proof || !sigHeader) return refuse(400, ["missing_proof_or_payment"]);
    let payment: PaymentPayload;
    try {
      payment = decodePaymentSignatureHeader(sigHeader);
    } catch {
      return refuse(400, ["bad_payment_header"]);
    }
    const paymentId = hashOf(payment.payload);
    if (store.hasSeenPayment(paymentId)) return refuse(409, ["payment_replayed"], proof.badge);
    store.markPaymentSeen(paymentId);

    // Who is paying, and can they prove it?
    const verdict = await cfg.registry.check(proof.badge);
    const issues: string[] = [];
    if (proof.badge !== p.buyerBadge) issues.push("badge_changed_since_quote");
    if (!verdict.verified) issues.push("buyer_not_verified", ...verdict.issues);
    issues.push(...(await checkBadgeProof(proof, { audience: cfg.badge, orderHash: p.orderHash, nonce: p.challenge.nonce, session: p.session }, [verdict.owner, verdict.agentWallet], cfg.verifier)));

    // The owner's mandate, checked here as well: a compromised buyer runtime that skips its own
    // mandate check still cannot get paid outside the owner's limits.
    const mandateHeader = decodeHeader<MandateHeader>(req.header(H.mandate));
    let mandateCheck: { hash?: string; evaluation?: MandateEvaluation } = {};
    if (!mandateHeader) issues.push("mandate_missing");
    else {
      const m = await checkSignedMandate(mandateHeader.mandate, { agent: p.buyerBadge, owner: verdict.owner, publishedHash: verdict.mandateHash }, cfg.verifier);
      issues.push(...m.issues);
      if (m.mandate && m.issues.length === 0) {
        const spend = await checkSpend(
          mandateHeader.spend,
          { agent: p.buyerBadge, asset: m.mandate.asset, orderHash: p.orderHash, account: proof.account, atLeast: store.received(p.buyerBadge, m.mandate.asset) },
          cfg.verifier,
        );
        issues.push(...spend.issues);
        if (spend.spent !== undefined && spend.issues.length === 0) {
          const self = await cfg.registry.check(cfg.badge);
          const evaluation = evaluateMandate(
            m.mandate,
            {
              merchant: { badge: cfg.badge, verified: self.verified, business: self.ownerKind === "business" },
              asset: p.requirements.asset,
              amount: BigInt(p.requirements.amount),
              categories: p.order.categories,
              description: p.order.lines.map((l) => `${l.qty}x ${l.name}`).join(", "),
            },
            spend.spent,
          );
          mandateCheck = { hash: m.hash, evaluation };
          if (evaluation.decision === "deny") issues.push(...evaluation.reasons.map((r) => `mandate:${r}`));
          if (evaluation.decision === "consent") {
            const approval = await checkApproval(
              consent,
              { owner: m.mandate.owner, agent: p.buyerBadge, orderHash: p.orderHash, merchant: cfg.badge, amount: p.requirements.amount, asset: p.requirements.asset },
              cfg.verifier,
            );
            issues.push(...approval);
          }
        }
      }
    }

    // Age-restricted goods: zero-knowledge proof about the accountable owner.
    if (p.ageOver) {
      const a = attest.find((x) => x.kind === "age_over" && x.threshold >= p.ageOver!);
      const ok = a ? await cfg.attributes.verify(proof.account, a, p.challenge.nonce, p.ageRequest) : false;
      if (!ok) issues.push(`age_over_${p.ageOver}_not_proven`);
    }

    // The payer on the payment must be the account that proved the badge.
    const v = await cfg.rail.verify(payment, p.requirements);
    if (!v.isValid) issues.push(`payment_invalid:${v.invalidReason}`);
    else if (v.payer !== proof.account) issues.push("payer_not_badge_account");

    if (issues.length) return refuse(403, issues, proof.badge);
    cfg.ledger.append({
      type: "payment_verified",
      actor: cfg.badge,
      orderId,
      data: {
        buyer: proof.badge,
        payer: v.payer,
        ageOver: p.ageOver,
        mandate: mandateCheck.hash,
        mandateDecision: mandateCheck.evaluation?.decision,
        mandateReasons: mandateCheck.evaluation?.reasons,
        spentBefore: mandateCheck.evaluation?.spentToday,
        consent: consent ? { method: consent.method, textHash: consent.textHash, auditAnchorTx: consent.auditAnchorTx } : undefined,
      },
    });

    const s = await cfg.rail.settle(payment, p.requirements);
    if (!s.success) return refuse(402, [`settlement_failed:${s.errorReason}`], proof.badge);
    const receipt: Receipt = await signReceipt(
      {
        v: 1,
        orderId,
        orderHash: p.orderHash,
        paid: p.requirements.amount,
        asset: p.requirements.asset,
        network: s.network ?? cfg.rail.network,
        txHash: s.transaction,
        explorer: cfg.rail.explorerTx?.(s.transaction),
        buyer: proof.badge,
        payer: v.payer!,
        merchant: cfg.badge,
        payTo: p.requirements.payTo,
        mandateHash: mandateCheck.hash,
        settledAt: new Date().toISOString(),
      },
      cfg.prover,
    );
    p.state = "paid";
    p.paid = receipt;
    store.addReceived(proof.badge, receipt.asset, BigInt(receipt.paid));
    store.save();
    cfg.ledger.append({ type: "payment_settled", actor: cfg.badge, orderId, data: { amount: receipt.paid, asset: receipt.asset, txHash: s.transaction, buyer: proof.badge, direction: "in" } });
    cfg.ledger.append({ type: "delivery", actor: cfg.badge, orderId, data: { receiptHash: hashOf(receipt) }, privateRecord: receipt });
    res.status(200).setHeader(H.paymentResponse, encodePaymentResponseHeader(s)).json(receipt);
  }));

  /**
   * Receipt with its Merkle inclusion proof. 202 until the log batch holding the receipt's `delivery`
   * entry has been anchored (anchorPending on this ledger).
   */
  app.get("/receipts/:orderId", (req: Request, res: Response) => {
    const p = pending.get(req.params.orderId);
    if (!p?.paid) return res.status(404).json({ error: "unknown_receipt" });
    const proof = buildReceiptProof(cfg.ledger, p.paid);
    if (!proof) return res.status(202).json({ status: "pending_anchor", receipt: p.paid });
    res.json(proof);
  });

  return app;
}
