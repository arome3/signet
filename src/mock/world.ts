import { generateKeyPairSync, sign as edSign, verify as edVerify, KeyObject } from "node:crypto";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { canonicalJson, hashOf, randomHex } from "../core/canonical.js";
import type { AnchorReceipt, AnchorSink } from "../core/anchor.js";
import type {
  AccountProver,
  AccountVerifier,
  AgentRegistry,
  AttributeProof,
  AttributeProver,
  AttributeVerifier,
  BadgeVerdict,
  ChainReader,
  OwnerKind,
  PaymentRail,
} from "../core/types.js";

/**
 * Offline stand-in for Concordium testnet: accounts with ed25519 keys and identity-provider
 * indices, a CIS-8004-like registry, PLT balances, a sponsoring facilitator and RegisterData.
 * Used by tests and `npm run demo`. Every value it returns is marked as mock where relevant.
 */
export const MOCK_NETWORK = "ccd:mock";

/** Identity-provider indices used by the mock (live values come from config). */
export const MOCK_IDP = { human: 0, business: 3, agent: 7 } as const;

interface Account {
  address: string;
  pub: KeyObject;
  priv: KeyObject;
  ipIdentity: number;
  dob?: string;
  balances: Map<string, bigint>;
}

interface AgentRecord {
  badge: string;
  owner: string;
  agentWallet?: string;
  active: boolean;
  cardHashMatches: boolean;
  metadata: Record<string, string>;
}

export class MockWorld {
  accounts = new Map<string, Account>();
  agents = new Map<string, AgentRecord>();
  dataRegistrations: { txHash: string; sender: string; data: string; ts: string }[] = [];
  /** Settled transfers by tx hash (stands in for the chain; a tx can only be included once). */
  transfers = new Map<string, { from: string; to: string; asset: string; amount: string; sponsor: string }>();
  facilitator: string;
  /** Simulated time to finality for settlements (tests use it to force overlapping requests). */
  settleLatencyMs = 0;

  constructor() {
    this.facilitator = this.createAccount("human").address;
  }

  createAccount(kind: Exclude<OwnerKind, "unknown">, opts: { dob?: string } = {}): Account {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const address = "mock" + randomHex(20);
    const acc: Account = { address, pub: publicKey, priv: privateKey, ipIdentity: MOCK_IDP[kind], dob: opts.dob, balances: new Map() };
    this.accounts.set(address, acc);
    return acc;
  }

  mint(address: string, asset: string, amount: bigint) {
    const a = this.mustAccount(address);
    a.balances.set(asset, (a.balances.get(asset) ?? 0n) + amount);
  }

  balance(address: string, asset: string): bigint {
    return this.mustAccount(address).balances.get(asset) ?? 0n;
  }

  registerAgent(owner: string, opts: { agentWallet?: string; metadata?: Record<string, string> } = {}): string {
    const badge = "Mock" + randomHex(8);
    this.agents.set(badge, { badge, owner, agentWallet: opts.agentWallet, active: true, cardHashMatches: true, metadata: opts.metadata ?? {} });
    return badge;
  }

  /** Sets the badge's `signet.mandate` metadata (the owner publishes the mandate hash). */
  publishMandate(badge: string, hash: string) {
    const r = this.agents.get(badge);
    if (!r) throw new Error(`unknown mock badge ${badge}`);
    r.metadata["signet.mandate"] = hash;
  }

  revoke(badge: string) {
    const r = this.agents.get(badge);
    if (r) r.active = false;
  }

  tamperCard(badge: string) {
    const r = this.agents.get(badge);
    if (r) r.cardHashMatches = false;
  }

  mustAccount(address: string): Account {
    const a = this.accounts.get(address);
    if (!a) throw new Error(`unknown mock account ${address}`);
    return a;
  }

  kindOf(ip: number): OwnerKind {
    return ip === MOCK_IDP.agent ? "agent" : ip === MOCK_IDP.business ? "business" : ip === MOCK_IDP.human ? "human" : "unknown";
  }

  // ---- adapters --------------------------------------------------------------------------

  registry(): AgentRegistry {
    return {
      check: async (badge: string): Promise<BadgeVerdict> => {
        const r = this.agents.get(badge);
        if (!r) return { badge, network: MOCK_NETWORK, found: false, active: false, cardHashMatches: false, verified: false, ownerKind: "unknown", issues: ["not_registered"] };
        const owner = this.accounts.get(r.owner);
        const issues: string[] = [];
        if (!r.active) issues.push("revoked");
        if (!r.cardHashMatches) issues.push("card_hash_mismatch");
        return {
          badge,
          network: MOCK_NETWORK,
          found: true,
          active: r.active,
          cardHashMatches: r.cardHashMatches,
          verified: r.active && r.cardHashMatches,
          owner: r.owner,
          agentWallet: r.agentWallet,
          agentUri: `https://cards.mock/${badge}.json`,
          ownerKind: owner ? this.kindOf(owner.ipIdentity) : "unknown",
          identityProvider: owner?.ipIdentity,
          mandateHash: r.metadata["signet.mandate"],
          issues,
        };
      },
    };
  }

  prover(address: string): AccountProver {
    const a = this.mustAccount(address);
    return {
      account: address,
      sign: async (message: string) => edSign(null, Buffer.from(message), a.priv).toString("hex"),
    };
  }

  verifier(): AccountVerifier {
    return {
      verify: async (account, message, signature) => {
        const a = this.accounts.get(account);
        if (!a || typeof signature !== "string") return false;
        return edVerify(null, Buffer.from(message), a.pub, Buffer.from(signature, "hex"));
      },
    };
  }

  /** Simulates a zero-knowledge "age over N" proof from the account's identity attributes. */
  attributeProver(address: string): AttributeProver {
    const a = this.mustAccount(address);
    return {
      prove: async (kind, threshold, challenge): Promise<AttributeProof> => {
        const ok = !!a.dob && ageOn(a.dob, new Date()) >= threshold;
        const statement = canonicalJson({ kind, threshold, challenge, holds: ok });
        return { kind, threshold, proof: { mock: true, account: address, holds: ok, sig: edSign(null, Buffer.from(statement), a.priv).toString("hex") } };
      },
    };
  }

  attributeVerifier(): AttributeVerifier {
    return {
      verify: async (account, p, challenge) => {
        const proof = p.proof as { account: string; holds: boolean; sig: string };
        const a = this.accounts.get(account);
        if (!a || proof.account !== account || !proof.holds) return false;
        const statement = canonicalJson({ kind: p.kind, threshold: p.threshold, challenge, holds: true });
        return edVerify(null, Buffer.from(statement), a.pub, Buffer.from(proof.sig, "hex"));
      },
    };
  }

  anchorSink(sender: string): AnchorSink {
    return {
      network: MOCK_NETWORK,
      register: async (data: Uint8Array): Promise<AnchorReceipt> => {
        const txHash = randomHex(32);
        this.dataRegistrations.push({ txHash, sender, data: Buffer.from(data).toString("hex"), ts: new Date().toISOString() });
        return { txHash, network: MOCK_NETWORK, explorerUrl: `mock://tx/${txHash}` };
      },
    };
  }

  /** Finalized-chain view for receipt verification. */
  chainReader(): ChainReader {
    return {
      network: MOCK_NETWORK,
      registeredData: async (txHash) => {
        const r = this.dataRegistrations.find((d) => d.txHash === txHash);
        return r ? { sender: r.sender, data: new Uint8Array(Buffer.from(r.data, "hex")) } : undefined;
      },
      transfers: async (txHash) => {
        const t = this.transfers.get(txHash);
        return t ? [{ from: t.from, to: t.to, asset: t.asset, amount: t.amount }] : undefined;
      },
    };
  }

  /** Payer-side rail bound to one sender account. Seller side ignores `sender`. */
  rail(sender?: string): PaymentRail {
    const world = this;
    return {
      network: MOCK_NETWORK,
      async requirements({ payTo, asset, amount, maxTimeoutSeconds = 120 }) {
        return { scheme: "exact", network: MOCK_NETWORK, asset, amount: amount.toString(), payTo, maxTimeoutSeconds, extra: { feePayer: world.facilitator } } as PaymentRequirements;
      },
      async createPayment(req) {
        if (!sender) throw new Error("rail has no sender");
        const tx = { version: 1, sender, sponsor: String(req.extra.feePayer), to: req.payTo, asset: req.asset, amount: req.amount, nonce: randomHex(8), expiry: Math.floor(Date.now() / 1000) + 300 };
        const sig = edSign(null, Buffer.from(canonicalJson(tx)), world.mustAccount(sender).priv).toString("hex");
        return { x402Version: 2, accepted: req, payload: { signedTransaction: tx, signature: sig } } as PaymentPayload;
      },
      async verify(p, req): Promise<VerifyResponse> {
        const tx = p.payload.signedTransaction as Record<string, any>;
        const sig = p.payload.signature as string;
        const a = world.accounts.get(tx?.sender);
        if (!a) return { isValid: false, invalidReason: "unknown_sender" };
        if (!edVerify(null, Buffer.from(canonicalJson(tx)), a.pub, Buffer.from(sig, "hex"))) return { isValid: false, invalidReason: "bad_sender_signature", payer: tx.sender };
        if (tx.to !== req.payTo) return { isValid: false, invalidReason: "wrong_recipient", payer: tx.sender };
        if (tx.amount !== req.amount) return { isValid: false, invalidReason: "wrong_amount", payer: tx.sender };
        if (tx.asset !== req.asset) return { isValid: false, invalidReason: "wrong_asset", payer: tx.sender };
        if (tx.sponsor !== world.facilitator) return { isValid: false, invalidReason: "wrong_sponsor", payer: tx.sender };
        if (tx.expiry < Date.now() / 1000) return { isValid: false, invalidReason: "expired", payer: tx.sender };
        if (world.balance(tx.sender, tx.asset) < BigInt(tx.amount)) return { isValid: false, invalidReason: "insufficient_funds", payer: tx.sender };
        return { isValid: true, payer: tx.sender };
      },
      async settle(p, req): Promise<SettleResponse> {
        if (world.settleLatencyMs) await new Promise((r) => setTimeout(r, world.settleLatencyMs));
        const v = await this.verify(p, req);
        const tx = p.payload.signedTransaction as Record<string, any>;
        if (!v.isValid) return { success: false, errorReason: v.invalidReason, transaction: "", network: MOCK_NETWORK, payer: v.payer };
        const txHash = hashOf({ tx, sig: p.payload.signature });
        if (world.transfers.has(txHash)) return { success: false, errorReason: "duplicate_transaction", transaction: "", network: MOCK_NETWORK, payer: v.payer };
        world.transfers.set(txHash, { from: tx.sender, to: tx.to, asset: tx.asset, amount: tx.amount, sponsor: tx.sponsor });
        world.mustAccount(tx.sender).balances.set(tx.asset, world.balance(tx.sender, tx.asset) - BigInt(tx.amount));
        world.mint(tx.to, tx.asset, BigInt(tx.amount));
        return { success: true, transaction: txHash, network: MOCK_NETWORK, payer: tx.sender, amount: tx.amount };
      },
      explorerTx: (h) => `mock://tx/${h}`,
    };
  }
}

export function ageOn(dob: string, now: Date): number {
  const d = new Date(dob);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
