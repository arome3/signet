import { createHash, randomBytes } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted recursively, bigint encoded as decimal strings.
 * Every hash Signet publishes (mandates, audit entries, orders) is taken over this form,
 * so any party can recompute it from the same data.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(normalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = normalize(v);
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Binary Merkle root over hex leaves (sha256, duplicate last leaf on odd levels). */
export function merkleRoot(leavesHex: string[]): string {
  if (leavesHex.length === 0) return sha256Hex("");
  let level: Buffer[] = leavesHex.map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(createHash("sha256").update(Buffer.concat([left, right])).digest());
    }
    level = next;
  }
  return level[0].toString("hex");
}

/** One step of a Merkle inclusion proof: the sibling hash and which side it sits on. */
export interface MerkleStep {
  sibling: string;
  side: "L" | "R";
}

const nodeHash = (l: Buffer, r: Buffer) => createHash("sha256").update(Buffer.concat([l, r])).digest();

/** Inclusion proof for leaf `index`, matching merkleRoot() (odd levels duplicate their last node). */
export function merkleProof(leavesHex: string[], index: number): MerkleStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= leavesHex.length) throw new Error(`leaf ${index} out of range`);
  const path: MerkleStep[] = [];
  let level: Buffer[] = leavesHex.map((h) => Buffer.from(h, "hex"));
  let i = index;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const sibling = isRight ? level[i - 1] : (level[i + 1] ?? level[i]);
    path.push({ sibling: sibling.toString("hex"), side: isRight ? "L" : "R" });
    const next: Buffer[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(nodeHash(level[j], level[j + 1] ?? level[j]));
    level = next;
    i = Math.floor(i / 2);
  }
  return path;
}

/**
 * Checks that `leafHex` sits at position `index` of a tree of `size` leaves with root `rootHex`.
 * Position and size are checked too, so a proof cannot be re-used for another entry of the batch.
 */
export function verifyMerkleProof(leafHex: string, path: MerkleStep[], rootHex: string, index: number, size: number): boolean {
  if (!Array.isArray(path) || !Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
  let depth = 0;
  for (let n = size; n > 1; n = Math.ceil(n / 2)) depth++;
  if (path.length !== depth) return false;
  let acc = Buffer.from(leafHex, "hex");
  let i = index;
  let width = size;
  for (const step of path) {
    if (!step || !/^[0-9a-f]{64}$/.test(step.sibling)) return false;
    const sib = Buffer.from(step.sibling, "hex");
    const isRight = i % 2 === 1;
    if (step.side !== (isRight ? "L" : "R")) return false;
    // The last node of an odd level is paired with itself.
    if (!isRight && i === width - 1 && !sib.equals(acc)) return false;
    acc = isRight ? nodeHash(sib, acc) : nodeHash(acc, sib);
    i = Math.floor(i / 2);
    width = Math.ceil(width / 2);
  }
  return acc.toString("hex") === rootHex;
}
