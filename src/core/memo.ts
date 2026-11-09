/**
 * Order memo carried by the payment transfer itself, so the chain alone links a payment to the order
 * it pays for: the merchant names it in the x402 requirements (`extra.memo`), the buyer checks it is
 * this order before signing, the merchant refuses a payment without it, and receipt verification
 * requires the finalized transfer to carry it.
 *
 * On chain the memo is a CBOR text string (what wallets and explorers decode and show). PLT transfers
 * may wrap it as an encoded-CBOR item (tag 24 around a byte string); both forms decode here.
 */
export const MEMO_PREFIX = "signet:";
/** Concordium's limit for transfer and PLT memos. */
export const MAX_MEMO_BYTES = 256;

export function orderMemo(orderHash: string): string {
  return MEMO_PREFIX + orderHash;
}

/** CBOR text string (major type 3) holding `text`. */
export function encodeMemo(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  let head: Buffer;
  if (body.length < 24) head = Buffer.from([0x60 | body.length]);
  else if (body.length < 0x100) head = Buffer.from([0x78, body.length]);
  else head = Buffer.from([0x79, body.length >> 8, body.length & 0xff]);
  const out = Buffer.concat([head, body]);
  if (out.length > MAX_MEMO_BYTES) throw new Error(`memo is ${out.length} bytes, max ${MAX_MEMO_BYTES}`);
  return new Uint8Array(out);
}

/** Length of a CBOR item whose head starts at `b[i]` with additional info `ai`; undefined if unsupported. */
function readLen(b: Uint8Array, i: number): { len: number; at: number } | undefined {
  const ai = b[i] & 0x1f;
  if (ai < 24) return { len: ai, at: i + 1 };
  if (ai === 24 && b.length >= i + 2) return { len: b[i + 1], at: i + 2 };
  if (ai === 25 && b.length >= i + 3) return { len: (b[i + 1] << 8) | b[i + 2], at: i + 3 };
  return undefined;
}

/**
 * The memo's text, or undefined when it is not exactly one CBOR text string (optionally inside a
 * tag-24 byte string). Strict: trailing bytes, other types and invalid UTF-8 are refused.
 */
export function decodeMemo(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes?.length) return undefined;
  let b = bytes;
  if (b[0] === 0xd8 && b[1] === 0x18) {
    if (b.length < 3 || b[2] >> 5 !== 2) return undefined;
    const l = readLen(b, 2);
    if (!l || l.at + l.len !== b.length) return undefined;
    b = b.subarray(l.at);
  }
  if (b[0] >> 5 !== 3) return undefined;
  const l = readLen(b, 0);
  if (!l || l.at + l.len !== b.length) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(l.at));
  } catch {
    return undefined;
  }
}

/**
 * Like decodeMemo, but also accepts the memo in Concordium's serialized DataBlob form (u16 big-endian
 * length, then the bytes). Unambiguous: a CBOR text memo never starts with 0x00.
 */
export function decodeMemoBlob(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes?.length) return undefined;
  if (bytes.length >= 2 && bytes[0] === 0 && ((bytes[0] << 8) | bytes[1]) === bytes.length - 2) return decodeMemo(bytes.subarray(2));
  return decodeMemo(bytes);
}
