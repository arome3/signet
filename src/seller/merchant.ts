import express, { type Request, type Response } from "express";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { hashOf, randomHex } from "../core/canonical.js";
import { type BadgeProof, type Challenge, checkBadgeProof, decodeHeader, newChallenge, proveBadge } from "../core/challenge.js";
import type { AuditLedger } from "../core/ledger.js";
import { H, type Order, type OrderLine, type Receipt, type SignetOffer } from "../core/protocol.js";
import type { AccountProver, AccountVerifier, AgentRegistry, AttributeProof, AttributeVerifier, ConsentResult, PaymentRail } from "../core/types.js";

export interface CatalogItem {
  sku: string;
  name: string;
  unitPrice: bigint;
  category: string;
  /** Minimum age of the buyer's accountable owner. */
  ageRestricted?: number;
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
  /** Live mode: create and anchor a Verify & Access request for "owner is at least N". */
  makeAgeRequest?: (threshold: number, orderHash: string) => Promise<unknown>;
}

interface Pending {
  order: Order;
  orderHash: string;
  challenge: Challenge;
  requirements: PaymentRequirements;
  buyerBadge: string;
  ageOver?: number;
  ageRequest?: unknown;
  paid?: Receipt;
}

/**
 * Seller-side Signet as an Express app: quotes orders over x402, refuses agents that cannot prove
 * an accountable owner, checks age-restricted baskets with zero-knowledge attribute proofs, and
 * settles through the facilitator (sponsored Concordium transaction, so buyers never hold CCD).
 */
export function createMerchantApp(cfg: SellerConfig) {
  const policy: SellerPolicy = { requireAgentAccount: false, allowHumanBackedAgents: true, ...cfg.policy };
  const pending = new Map<string, Pending>();
  const app = express();
  app.use(express.json());

  const reject = (res: Response, status: number, reasons: string[], orderId?: string, actor = cfg.badge) => {
    cfg.ledger.append({ type: "payment_rejected", actor, orderId, data: { reasons, by: cfg.badge } });
    res.status(status).json({ error: "signet_rejected", reasons });
  };

  app.get("/.well-known/signet", (_req, res) => {
    res.json({ merchant: cfg.name, badge: cfg.badge, asset: cfg.asset, network: cfg.rail.network, catalog: cfg.catalog.map((c) => ({ ...c, unitPrice: c.unitPrice.toString() })) });
  });

  app.post("/orders", async (req: Request, res: Response) => {
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
    const challenge = newChallenge(cfg.badge, orderHash);
    const merchantProof: BadgeProof = await proveBadge(cfg.badge, cfg.prover, { ...newChallenge(buyerBadge, orderHash), nonce: buyerNonce });
    const requirements = await cfg.rail.requirements({ payTo: cfg.payTo, asset: cfg.asset, amount: total });
    const ageRequest = ageOver && cfg.makeAgeRequest ? await cfg.makeAgeRequest(ageOver, orderHash) : undefined;
    pending.set(order.id, { order, orderHash, challenge, requirements, buyerBadge, ageOver, ageRequest });

    const offer: SignetOffer = {
      merchant: { badge: cfg.badge, name: cfg.name, domain: cfg.domain },
      order,
      orderHash,
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
    cfg.ledger.append({ type: "request", actor: cfg.badge, orderId: order.id, data: { buyer: buyerBadge, total: order.total, asset: order.asset, categories: order.categories, ageOver }, privateRecord: order });
    res.status(402).setHeader(H.paymentRequired, encodePaymentRequiredHeader(pr)).json({ error: "payment_required", orderId: order.id });
  });

  app.post("/orders/:id/pay", async (req: Request, res: Response) => {
    const p = pending.get(req.params.id);
    if (!p) return reject(res, 404, ["unknown_order"]);
    if (p.paid) return res.status(200).json(p.paid);
    const orderId = p.order.id;

    const proof = decodeHeader<BadgeProof>(req.header(H.proof));
    const attest = decodeHeader<AttributeProof[]>(req.header(H.attest)) ?? [];
    const consent = decodeHeader<ConsentResult>(req.header(H.consent));
    const sigHeader = req.header(H.paymentSignature);
    if (!proof || !sigHeader) return reject(res, 400, ["missing_proof_or_payment"], orderId);
    let payment: PaymentPayload;
    try {
      payment = decodePaymentSignatureHeader(sigHeader);
    } catch {
      return reject(res, 400, ["bad_payment_header"], orderId);
    }

    // Who is paying, and can they prove it?
    const verdict = await cfg.registry.check(proof.badge);
    const issues: string[] = [];
    if (proof.badge !== p.buyerBadge) issues.push("badge_changed_since_quote");
    if (!verdict.verified) issues.push("buyer_not_verified", ...verdict.issues);
    issues.push(...(await checkBadgeProof(proof, { audience: cfg.badge, orderHash: p.orderHash, nonce: p.challenge.nonce }, [verdict.owner, verdict.agentWallet], cfg.verifier)));

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

    if (issues.length) return reject(res, 403, issues, orderId, proof.badge);
    cfg.ledger.append({ type: "payment_verified", actor: cfg.badge, orderId, data: { buyer: proof.badge, payer: v.payer, ageOver: p.ageOver, consent: consent ? { method: consent.method, textHash: consent.textHash, auditAnchorTx: consent.auditAnchorTx } : undefined } });

    const s = await cfg.rail.settle(payment, p.requirements);
    if (!s.success) return reject(res, 402, [`settlement_failed:${s.errorReason}`], orderId, proof.badge);
    const receipt: Receipt = {
      orderId,
      orderHash: p.orderHash,
      paid: p.requirements.amount,
      asset: p.requirements.asset,
      txHash: s.transaction,
      explorer: cfg.rail.explorerTx?.(s.transaction),
      buyer: proof.badge,
      merchant: cfg.badge,
    };
    p.paid = receipt;
    cfg.ledger.append({ type: "payment_settled", actor: cfg.badge, orderId, data: { amount: receipt.paid, asset: receipt.asset, txHash: s.transaction, buyer: proof.badge, direction: "in" } });
    cfg.ledger.append({ type: "delivery", actor: cfg.badge, orderId, data: { receiptHash: hashOf(receipt) }, privateRecord: receipt });
    res.status(200).setHeader(H.paymentResponse, encodePaymentResponseHeader(s)).json(receipt);
  });

  return app;
}
