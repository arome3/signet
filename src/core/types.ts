import type { AccountSignature } from "./signing.js";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";

export type OwnerKind = "human" | "business" | "agent" | "unknown";

/** Result of resolving a Verified-by-Concordium badge against the CIS-8004 Agent Registry. */
export interface BadgeVerdict {
  badge: string;
  network: string;
  found: boolean;
  active: boolean;
  /** Agent Card at agent_uri hashes to the on-chain metadata_hash. */
  cardHashMatches: boolean;
  /** found && active && cardHashMatches */
  verified: boolean;
  owner?: string;
  agentWallet?: string;
  agentUri?: string;
  /** Derived from the identity provider that issued the owner account's credential. */
  ownerKind: OwnerKind;
  /** Identity provider index of the owner account's first credential, when known. */
  identityProvider?: number;
  /** Value of the `signet.mandate` metadata key, if the agent publishes one. */
  mandateHash?: string;
  issues: string[];
}

export interface AgentRegistry {
  check(badge: string): Promise<BadgeVerdict>;
}

/** Proves control of a Concordium account (the agent's own account or its owner's). */
export interface AccountProver {
  readonly account: string;
  sign(message: string): Promise<unknown>;
}

export interface AccountVerifier {
  verify(account: string, message: string, signature: unknown): Promise<boolean>;
}

export interface ConsentRequest {
  orderId: string;
  /** Hash of the merchant's order; the owner's approval is bound to it. */
  orderHash: string;
  agent: string;
  owner: string;
  merchantBadge: string;
  merchantName?: string;
  amount: bigint;
  asset: string;
  summary: string;
  reasons: string[];
}

export interface ConsentResult {
  approved: boolean;
  method: "concordium-id-app" | "terminal" | "auto";
  /** RegisterData tx of the CCDVRA consent request anchor, when done on-chain. */
  requestAnchorTx?: string;
  /** RegisterData tx of the CCDVAA audit anchor of the owner's response. */
  auditAnchorTx?: string;
  /** Hash of the consent text the owner saw. */
  textHash: string;
  /**
   * Owner's signature over the approval (see approvalPayload). This is what lets a merchant verify the
   * approval independently. Live ID App approvals carry CCDVRA/CCDVAA anchors instead; merchants
   * cannot check those yet, so they refuse them (fail closed) until that check is built.
   */
  ownerSignature?: AccountSignature;
}

export interface ConsentProvider {
  request(req: ConsentRequest): Promise<ConsentResult>;
}

/** Attribute proofs about the agent's accountable owner (e.g. over 18), without revealing data. */
export interface AttributeProof {
  kind: "age_over";
  threshold: number;
  /** Opaque proof (a Concordium verifiable presentation in live mode). */
  proof: unknown;
}

/**
 * `request` is the seller's anchored Concordium VerificationRequestV1 (JSON) in live mode;
 * the mock ignores it and binds the proof to `challenge` instead.
 */
export interface AttributeProver {
  prove(kind: "age_over", threshold: number, challenge: string, request?: unknown): Promise<AttributeProof>;
}

export interface AttributeVerifier {
  verify(account: string, p: AttributeProof, challenge: string, request?: unknown): Promise<boolean>;
}

/** The money rail. Live = x402 exact scheme on Concordium (PLT + sponsored tx). */
export interface PaymentRail {
  readonly network: string;
  /** Seller side: requirements for a price, with the facilitator as fee payer. */
  requirements(input: { payTo: string; asset: string; amount: bigint; maxTimeoutSeconds?: number }): Promise<PaymentRequirements>;
  /** Buyer side: build and sender-sign the payment. */
  createPayment(req: PaymentRequirements): Promise<PaymentPayload>;
  /** Seller/facilitator side. */
  verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse>;
  settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse>;
  explorerTx?(txHash: string): string | undefined;
}

/**
 * Read-only view of finalized chain data, used to verify receipts independently of either party.
 * Returns undefined when the transaction is unknown or not finalized.
 */
export interface ChainReader {
  readonly network: string;
  registeredData(txHash: string): Promise<{ sender: string; data: Uint8Array } | undefined>;
  /** Token transfers in a transaction; amounts in atomic units. */
  transfers(txHash: string): Promise<{ from: string; to: string; asset: string; amount: string }[] | undefined>;
}

/**
 * Proves a domain belongs to an account: the domain publishes a DNS TXT record at `_signet.<domain>`
 * with the value `signet-account=<account>`. The merchant's signed listing proves the other direction.
 */
export interface DomainVerifier {
  verify(domain: string, account: string): Promise<boolean>;
}
