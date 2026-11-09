import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { hashOf, type MerkleStep, merkleProof, merkleRoot, sha256Hex } from "./canonical.js";

/**
 * Hash-chained, append-only accountability log.
 *
 * Each entry stores only public, non-personal facts (badges, amounts, decisions, hashes).
 * Anything sensitive (full order, presentation, consent text) is kept by the operator and
 * referenced here only by its SHA-256 `dataHash`, mirroring Concordium's Verify & Access
 * audit-record pattern (private record + public hash anchor).
 *
 * Batches of entries are committed on-chain via a Merkle root (see anchor.ts), which gives
 * the EU AI Act Art. 12 properties: automatic, tamper-evident, time-stamped event records
 * that trace back to an accountable owner.
 */
export type EntryType =
  | "mandate_published"
  | "request"
  | "counterparty_check"
  | "mandate_check"
  | "consent_requested"
  | "consent_result"
  | "payment_signed"
  | "payment_verified"
  | "payment_settled"
  | "payment_rejected"
  | "delivery"
  | "anchor";

export interface LedgerEntry {
  seq: number;
  ts: string;
  type: EntryType;
  /** Badge of the agent whose action this is. */
  actor: string;
  /** Correlates all entries of one purchase. */
  orderId?: string;
  /** Public summary (no PII). */
  data: Record<string, unknown>;
  /** SHA-256 of the private record held off-chain, if any. */
  dataHash?: string;
  prevHash: string;
  hash: string;
}

const GENESIS = sha256Hex("signet:genesis:v1");

/** Recomputes one entry's hash from its own fields (the chain link is checked by AuditLedger.verify). */
export function entryHashValid(e: LedgerEntry): boolean {
  try {
    const { hash, ...base } = e;
    return typeof hash === "string" && hashOf(base) === hash;
  } catch {
    return false;
  }
}

/** Where an entry was committed on-chain, and the path from it to the anchored root. */
export interface InclusionProof {
  anchor: { txHash: string; network: string; from: number; to: number; root: string };
  path: MerkleStep[];
}

export class AuditLedger {
  private entries: LedgerEntry[] = [];

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      this.entries = lines.map((l) => JSON.parse(l) as LedgerEntry);
    }
  }

  get all(): readonly LedgerEntry[] {
    return this.entries;
  }

  get head(): string {
    return this.entries.at(-1)?.hash ?? GENESIS;
  }

  append(e: { type: EntryType; actor: string; orderId?: string; data?: Record<string, unknown>; privateRecord?: unknown }): LedgerEntry {
    const base = {
      seq: this.entries.length,
      ts: new Date().toISOString(),
      type: e.type,
      actor: e.actor,
      orderId: e.orderId,
      data: e.data ?? {},
      dataHash: e.privateRecord === undefined ? undefined : hashOf(e.privateRecord),
      prevHash: this.head,
    };
    const entry: LedgerEntry = { ...base, hash: hashOf(base) };
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Re-derives every hash and link. Returns the first broken sequence number, or -1. */
  verify(): { ok: boolean; brokenAt: number } {
    let prev = GENESIS;
    for (const e of this.entries) {
      const { hash, ...base } = e;
      if (e.prevHash !== prev || hashOf(base) !== hash) return { ok: false, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true, brokenAt: -1 };
  }

  /** Merkle root over entry hashes in [from, to). */
  rootOf(from: number, to: number): string {
    return merkleRoot(this.entries.slice(from, to).map((e) => e.hash));
  }

  /**
   * Index of the first entry not yet committed on-chain. The `anchor` entry itself is not
   * re-anchored on its own; the next batch's first entry links to it through prevHash.
   */
  unanchoredFrom(): number {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === "anchor") return i + 1;
    }
    return 0;
  }

  /** Inclusion proof for entry `seq`, once a later anchor entry covers it; undefined before that. */
  inclusionProof(seq: number): InclusionProof | undefined {
    const a = this.entries.find((e) => e.type === "anchor" && Number(e.data.from) <= seq && seq < Number(e.data.to));
    if (!a) return undefined;
    const from = Number(a.data.from);
    const to = Number(a.data.to);
    const path = merkleProof(this.entries.slice(from, to).map((e) => e.hash), seq - from);
    return { anchor: { txHash: String(a.data.txHash), network: String(a.data.network), from, to, root: String(a.data.root) }, path };
  }

  byOrder(orderId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.orderId === orderId);
  }

  /** Buyer side: what `actor` has paid out today in `asset`. */
  spentToday(actor: string, asset: string, now = new Date()): bigint {
    return this.settledToday((e) => e.actor === actor && e.data.direction !== "in", asset, now);
  }

  /** Merchant side: what this ledger has received today from the buyer badge `from`. */
  receivedToday(from: string, asset: string, now = new Date()): bigint {
    return this.settledToday((e) => e.data.direction === "in" && e.data.buyer === from, asset, now);
  }

  private settledToday(match: (e: LedgerEntry) => boolean, asset: string, now: Date): bigint {
    const day = now.toISOString().slice(0, 10);
    return this.entries
      .filter((e) => e.type === "payment_settled" && e.data.asset === asset && e.ts.startsWith(day) && match(e))
      .reduce((sum, e) => sum + BigInt(String(e.data.amount)), 0n);
  }
}
