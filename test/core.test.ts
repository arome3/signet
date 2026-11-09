import { describe, expect, it } from "vitest";
import { canonicalJson, merkleRoot, sha256Hex } from "../src/core/canonical.js";
import { decodeAnchor, encodeAnchor } from "../src/core/anchor.js";
import { evaluateMandate, formatAmount, mandateHash } from "../src/core/mandate.js";
import { adaMandate, USDR } from "../demo/scenario.js";

const m = adaMandate("KitBadge01", "adaAccount01");
const merchant = { badge: "Shop", verified: true, business: true };
const intent = (amount: number, categories = ["groceries"]) => ({ merchant, asset: "USDR", amount: USDR(amount), categories, description: "" });

describe("mandate", () => {
  it("allows inside limits", () => expect(evaluateMandate(m, intent(10), 0n).decision).toBe("allow"));
  it("asks over the per-payment limit", () => expect(evaluateMandate(m, intent(25), 0n).reasons).toContain("per_payment_limit_exceeded"));
  it("asks over the daily limit", () => expect(evaluateMandate(m, intent(10), USDR(45)).reasons).toEqual(["daily_limit_exceeded"]));
  it("denies above the hard limit even if consent would apply", () => expect(evaluateMandate(m, intent(250), 0n).decision).toBe("deny"));
  it("denies blocked categories", () => expect(evaluateMandate(m, intent(5, ["tobacco"]), 0n).decision).toBe("deny"));
  it("denies unverified or non-business merchants", () => {
    expect(evaluateMandate(m, { ...intent(1), merchant: { ...merchant, verified: false } }, 0n).reasons).toContain("merchant_not_verified");
    expect(evaluateMandate(m, { ...intent(1), merchant: { ...merchant, business: false } }, 0n).reasons).toContain("merchant_not_business");
  });
  it("denies the wrong asset and expired mandates", () => {
    expect(evaluateMandate(m, { ...intent(1), asset: "EURR" }, 0n).reasons).toContain("asset_not_allowed");
    expect(evaluateMandate(m, intent(1), 0n, new Date(Date.now() + 40 * 86400_000)).reasons).toContain("mandate_expired");
  });
  it("hashes deterministically regardless of key order", () => {
    const shuffled = Object.fromEntries(Object.entries(m).reverse()) as typeof m;
    expect(mandateHash(shuffled)).toBe(mandateHash(m));
  });
  it("formats amounts", () => expect(formatAmount(USDR(12.5), 6, "USDR")).toBe("12.5 USDR"));
});

describe("canonical + merkle", () => {
  it("sorts keys and encodes bigint", () => expect(canonicalJson({ b: 1n, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":"1"}'));
  it("computes a stable root", () => {
    const leaves = ["a", "b", "c"].map((x) => sha256Hex(x));
    expect(merkleRoot(leaves)).toBe(merkleRoot([...leaves]));
    expect(merkleRoot(leaves)).not.toBe(merkleRoot(leaves.slice(0, 2)));
  });
});

describe("anchor encoding", () => {
  it("fits RegisterData and round-trips", () => {
    const a = { type: "SGNT" as const, version: 1 as const, root: sha256Hex("r"), from: 0, to: 42, head: sha256Hex("h") };
    const bytes = encodeAnchor(a);
    expect(bytes.length).toBeLessThanOrEqual(256);
    const d = decodeAnchor(bytes);
    expect(d.type).toBe("SGNT");
    expect(d.to).toBe(42);
    expect(d.root).toBe(a.root);
  });
});
