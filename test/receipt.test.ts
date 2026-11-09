import { afterEach, describe, expect, it } from "vitest";
import { fetchReceiptProof } from "../src/buyer/agent.js";
import { anchorPending, encodeAnchor } from "../src/core/anchor.js";
import { hashOf, merkleProof, merkleRoot, sha256Hex, verifyMerkleProof } from "../src/core/canonical.js";
import type { Receipt, ReceiptProof } from "../src/core/protocol.js";
import { receiptBody, signReceipt, verifyReceipt } from "../src/core/receipt.js";
import { buildMockScenario, USDR, type Scenario } from "../demo/scenario.js";

describe("Merkle inclusion proofs", () => {
  it("prove every leaf of trees of size 1 to 9, at that leaf's position only", () => {
    for (let n = 1; n <= 9; n++) {
      const leaves = Array.from({ length: n }, (_, i) => sha256Hex(`leaf${i}`));
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        const path = merkleProof(leaves, i);
        expect(verifyMerkleProof(leaves[i], path, root, i, n), `n=${n} i=${i}`).toBe(true);
        if (n > 1) expect(verifyMerkleProof(leaves[i], path, root, (i + 1) % n, n), `wrong index n=${n} i=${i}`).toBe(false);
        expect(verifyMerkleProof(leaves[i], path, root, i, n + 8), `wrong size n=${n}`).toBe(false);
      }
    }
  });

  it("rejects a path with a tampered sibling or a different leaf", () => {
    const leaves = ["a", "b", "c", "d", "e"].map((x) => sha256Hex(x));
    const root = merkleRoot(leaves);
    const path = merkleProof(leaves, 2);
    expect(verifyMerkleProof(sha256Hex("x"), path, root, 2, 5)).toBe(false);
    const bad = path.map((s, i) => (i === 1 ? { ...s, sibling: sha256Hex("evil") } : s));
    expect(verifyMerkleProof(leaves[2], bad, root, 2, 5)).toBe(false);
  });
});

describe("receipts with inclusion proofs", () => {
  let s: Scenario;
  afterEach(() => s?.close());

  const deps = (s: Scenario) => ({ registry: s.world.registry(), verifier: s.world.verifier(), chain: s.world.chainReader() });

  /** Two paid orders, merchant log anchored, proof for the first. */
  async function paidAndAnchored() {
    s = await buildMockScenario();
    const a = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 2 }]);
    const b = await s.kit.purchase(s.shopUrl, [{ sku: "milk", qty: 1 }]);
    if (a.status !== "paid" || b.status !== "paid") throw new Error("setup purchase failed");
    expect(await fetchReceiptProof(s.shopUrl, a.receipt.orderId)).toBeUndefined(); // not anchored yet
    await anchorPending(s.merchantLedger, s.world.anchorSink(s.shop.address), s.shopBadge);
    const proof = (await fetchReceiptProof(s.shopUrl, a.receipt.orderId))!;
    const other = (await fetchReceiptProof(s.shopUrl, b.receipt.orderId))!;
    return { proof, other, receipt: a.receipt };
  }

  /** A dishonest merchant re-signs a changed receipt with its real key. */
  async function resign(r: Receipt, change: Partial<Receipt>): Promise<Receipt> {
    return signReceipt({ ...receiptBody(r), ...change }, s.world.prover(s.shop.address));
  }

  it("verifies end to end: signature, log entry, Merkle path, anchor and payment on chain", async () => {
    const { proof, receipt } = await paidAndAnchored();
    const v = await verifyReceipt(proof, deps(s));
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(Object.keys(v.checks)).toHaveLength(7);
    expect(receipt.mandateHash).toBe(s.kit.mandateHash);
    expect(s.kitLedger.all.find((e) => e.type === "delivery")!.data.receiptOk).toBe(true);
  });

  it("detects an edited receipt (amount changed, signature kept)", async () => {
    const { proof } = await paidAndAnchored();
    const v = await verifyReceipt({ ...proof, receipt: { ...proof.receipt, paid: USDR(1).toString() } }, deps(s));
    expect(v.ok).toBe(false);
    expect(v.checks.receipt_signature.ok).toBe(false);
    expect(v.checks.entry_commits_to_receipt.ok).toBe(false);
    expect(v.checks.payment_on_chain.ok).toBe(false);
  });

  it("detects a merchant re-signing a receipt after the fact: the anchored log disagrees", async () => {
    const { proof } = await paidAndAnchored();
    const forged = await resign(proof.receipt, { paid: USDR(50).toString() });
    const v = await verifyReceipt({ ...proof, receipt: forged }, deps(s));
    expect(v.checks.receipt_signature.ok).toBe(true);
    expect(v.checks.entry_commits_to_receipt).toEqual({ ok: false, detail: "entry_receipt_hash_mismatch" });
    expect(v.checks.payment_on_chain).toEqual({ ok: false, detail: "payment_does_not_match_receipt" });
  });

  it("detects a merchant that also rewrites its log entry to match", async () => {
    const { proof } = await paidAndAnchored();
    const forged = await resign(proof.receipt, { paid: USDR(50).toString() });
    const entry = { ...proof.entry, data: { receiptHash: hashOf(forged) }, dataHash: hashOf(forged) };
    expect((await verifyReceipt({ ...proof, receipt: forged, entry }, deps(s))).checks.entry_hash.ok).toBe(false);
    const { hash: _h, ...base } = entry;
    const rehashed = { ...entry, hash: hashOf(base) };
    const v = await verifyReceipt({ ...proof, receipt: forged, entry: rehashed }, deps(s));
    expect(v.checks.entry_hash.ok).toBe(true);
    expect(v.checks.merkle_inclusion).toEqual({ ok: false, detail: "path_does_not_reach_root" });
  });

  it("rejects another entry's Merkle path or a tampered path", async () => {
    const { proof, other } = await paidAndAnchored();
    expect((await verifyReceipt({ ...proof, path: other.path }, deps(s))).checks.merkle_inclusion.ok).toBe(false);
    const tampered = proof.path.map((st, i) => (i === 0 ? { ...st, sibling: sha256Hex("x") } : st));
    expect((await verifyReceipt({ ...proof, path: tampered }, deps(s))).checks.merkle_inclusion.ok).toBe(false);
  });

  it("rejects an anchor registered by someone other than the merchant", async () => {
    const { proof } = await paidAndAnchored();
    const attacker = s.world.createAccount("human");
    const fake = await s.world
      .anchorSink(attacker.address)
      .register(encodeAnchor({ type: "SGNT", version: 1, root: proof.anchor.root, from: proof.anchor.from, to: proof.anchor.to, head: proof.entry.hash }));
    const v = await verifyReceipt({ ...proof, anchor: { ...proof.anchor, txHash: fake.txHash } }, deps(s));
    expect(v.checks.anchor_on_chain).toEqual({ ok: false, detail: "anchor_sender_not_merchant" });
  });

  it("rejects an anchor transaction that does not exist, and a payment that never happened", async () => {
    const { proof } = await paidAndAnchored();
    const v1 = await verifyReceipt({ ...proof, anchor: { ...proof.anchor, txHash: sha256Hex("nope") } }, deps(s));
    expect(v1.checks.anchor_on_chain).toEqual({ ok: false, detail: "anchor_tx_not_found" });
    const forged = await resign(proof.receipt, { txHash: sha256Hex("no-such-payment") });
    expect((await verifyReceipt({ ...proof, receipt: forged }, deps(s))).checks.payment_on_chain).toEqual({ ok: false, detail: "payment_tx_not_found" });
  });

  it("rejects a receipt naming a payer that is not the buyer badge's account", async () => {
    const { proof } = await paidAndAnchored();
    const forged = await resign(proof.receipt, { payer: s.ada.address });
    expect((await verifyReceipt({ ...proof, receipt: forged }, deps(s))).checks.payer_bound_to_buyer.ok).toBe(false);
  });

  it("fails closed on a malformed proof and on a chain reader that errors", async () => {
    const { proof } = await paidAndAnchored();
    const v = await verifyReceipt({} as ReceiptProof, deps(s));
    expect(v.ok).toBe(false);
    expect(v.issues).toContain("merkle_inclusion:proof_malformed");
    const broken = { ...s.world.chainReader(), registeredData: async () => Promise.reject(new Error("node down")), transfers: async () => Promise.reject(new Error("node down")) };
    const v2 = await verifyReceipt(proof, { ...deps(s), chain: broken });
    expect(v2.ok).toBe(false);
    expect(v2.checks.anchor_on_chain.detail).toMatch(/check_error/);
  });
});
