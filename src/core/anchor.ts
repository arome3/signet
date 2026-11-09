import { Cbor } from "@concordium/web-sdk/plt";
import type { AuditLedger, LedgerEntry } from "./ledger.js";

/**
 * On-chain commitment format for a batch of ledger entries, registered with a Concordium
 * `RegisterData` transaction (max 256 bytes). Modelled on Concordium's own CCDVRA / CCDVAA
 * anchors: a CBOR map with a type tag, version, hash and small public part.
 */
export interface SignetAnchor {
  type: "SGNT";
  version: 1;
  /** Merkle root of entry hashes in [from, to). */
  root: string;
  from: number;
  to: number;
  /** Hash of the last entry, to pin chain order. */
  head: string;
}

export interface AnchorReceipt {
  txHash: string;
  explorerUrl?: string;
  network: string;
}

export interface AnchorSink {
  readonly network: string;
  register(data: Uint8Array): Promise<AnchorReceipt>;
}

export function encodeAnchor(a: SignetAnchor): Uint8Array {
  const bytes = Cbor.encode({
    type: a.type,
    version: a.version,
    root: Buffer.from(a.root, "hex"),
    from: a.from,
    to: a.to,
    head: Buffer.from(a.head, "hex").subarray(0, 16),
  }).bytes;
  if (bytes.length > 256) throw new Error(`anchor is ${bytes.length} bytes; RegisterData allows 256`);
  return bytes;
}

/** Commit everything not yet anchored. Returns undefined when there is nothing new. */
export async function anchorPending(
  ledger: AuditLedger,
  sink: AnchorSink,
  actor: string,
): Promise<{ anchor: SignetAnchor; receipt: AnchorReceipt; entry: LedgerEntry } | undefined> {
  const from = ledger.unanchoredFrom();
  const to = ledger.all.length;
  if (to <= from) return undefined;
  const anchor: SignetAnchor = {
    type: "SGNT",
    version: 1,
    root: ledger.rootOf(from, to),
    from,
    to,
    head: ledger.all[to - 1].hash,
  };
  const receipt = await sink.register(encodeAnchor(anchor));
  const entry = ledger.append({
    type: "anchor",
    actor,
    data: { from, to, root: anchor.root, txHash: receipt.txHash, network: receipt.network, explorer: receipt.explorerUrl },
  });
  return { anchor, receipt, entry };
}

export function decodeAnchor(bytes: Uint8Array): SignetAnchor {
  const m = Cbor.decode(Cbor.fromHexString(Buffer.from(bytes).toString("hex"))) as Record<string, unknown>;
  const hex = (v: unknown) => Buffer.from(v as Uint8Array).toString("hex");
  if (m.type !== "SGNT") throw new Error("not a Signet anchor");
  return { type: "SGNT", version: 1, root: hex(m.root), from: Number(m.from), to: Number(m.to), head: hex(m.head) };
}
