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
