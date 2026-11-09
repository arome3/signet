import type { BadgeProof, Challenge } from "./challenge.js";
import type { SignedMandate, SignedSpend } from "./mandate.js";
import type { AttributeProof, ConsentResult } from "./types.js";

/**
 * Signet wire protocol, layered on x402 v2.
 *
 *   1. Buyer  -> POST /orders                 body: { items }, headers X-SIGNET-AGENT: <badge>,
 *                                             X-SIGNET-NONCE: <buyer nonce>. Unverified agents get 403 here,
 *                                             before they are ever asked to pay.
 *   2. Seller <- 402, PAYMENT-REQUIRED header (official x402 v2 encoding) whose
 *                `extensions.signet` carries a SignetOffer: the order, the merchant's badge,
 *                the merchant's proof of controlling that badge (signed over the buyer nonce),
 *                a challenge for the buyer, and any attribute requirements (e.g. age_over 18).
 *   3. Buyer verifies the merchant, checks its mandate, asks the owner if needed, then
 *      -> POST /orders/:id/pay with
 *         PAYMENT-SIGNATURE (x402 payload, sponsored Concordium transfer, sender-signed)
 *         X-SIGNET-PROOF   (BadgeProof over the seller challenge)
 *         X-SIGNET-MANDATE (MandateHeader: owner-signed mandate + agent-signed spend-so-far)
 *         X-SIGNET-ATTEST  (AttributeProof[])
 *         X-SIGNET-CONSENT (ConsentResult with the owner's signature, when consent was needed)
 *   4. Seller re-checks everything itself (buyer proof, mandate signature and published hash,
 *      mandate decision on its own order, spend-so-far, owner approval, age, payer), then
 *      verifies+settles via the facilitator and returns 200 with PAYMENT-RESPONSE and the receipt.
 */
export const H = {
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
  agent: "X-SIGNET-AGENT",
  nonce: "X-SIGNET-NONCE",
  proof: "X-SIGNET-PROOF",
  attest: "X-SIGNET-ATTEST",
  consent: "X-SIGNET-CONSENT",
  mandate: "X-SIGNET-MANDATE",
} as const;

export interface MandateHeader {
  mandate: SignedMandate;
  spend: SignedSpend;
}

export interface OrderLine {
  sku: string;
  name: string;
  qty: number;
  unitPrice: string;
  category: string;
}

export interface Order {
  id: string;
  merchant: string;
  lines: OrderLine[];
  total: string;
  asset: string;
  categories: string[];
  createdAt: string;
}

export interface SignetOffer {
  merchant: { badge: string; name: string; domain?: string };
  order: Order;
  orderHash: string;
  /** Merchant proves it controls its badge, signed over the buyer's nonce. */
  merchantProof: BadgeProof;
  /** The buyer must sign this. */
  challenge: Challenge;
  requires: {
    ageOver?: number;
    /** Live mode: anchored Concordium VerificationRequestV1 (CCDVRA) the buyer must answer. */
    ageRequest?: unknown;
    /** Payer badge must belong to an account issued by an agent identity provider. */
    agentAccount?: boolean;
  };
}

export interface PayRequestHeaders {
  proof: BadgeProof;
  attest: AttributeProof[];
  consent?: ConsentResult;
}

export interface Receipt {
  orderId: string;
  orderHash: string;
  paid: string;
  asset: string;
  txHash: string;
  explorer?: string;
  buyer: string;
  merchant: string;
}
