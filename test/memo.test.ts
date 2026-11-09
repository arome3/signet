import { afterEach, describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { AccountAddress, CborMemo, TransactionEventTag, TransactionKindString, TransactionStatusEnum } from "@concordium/web-sdk";
import { randomBytes } from "node:crypto";
import { ConcordiumChainReader } from "../src/concordium/chain.js";
import { loadConfig } from "../src/concordium/config.js";
import { sha256Hex } from "../src/core/canonical.js";
import { decodeMemo, decodeMemoBlob, encodeMemo, orderMemo } from "../src/core/memo.js";
import { H } from "../src/core/protocol.js";
import { receiptBody, signReceipt, verifyReceipt } from "../src/core/receipt.js";
import { anchorPending } from "../src/core/anchor.js";
import { fetchReceiptProof } from "../src/buyer/agent.js";
import { buildMockScenario, type Scenario } from "../demo/scenario.js";
import { craftPay, post, quote } from "./helpers.js";

const memo = orderMemo(sha256Hex("order"));

describe("order memo codec", () => {
  it("round-trips short and long text, plain or wrapped as encoded CBOR (tag 24)", () => {
    for (const t of ["", "x", memo, "é".repeat(100)]) {
      const b = encodeMemo(t);
      expect(decodeMemo(b)).toBe(t);
      const wrapped = Buffer.concat([Buffer.from([0xd8, 0x18, 0x58, b.length]), b]);
      expect(decodeMemo(wrapped)).toBe(t);
    }
  });

  it("refuses anything but exactly one valid text string", () => {
    const b = Buffer.from(encodeMemo(memo));
    expect(decodeMemo(Buffer.concat([b, Buffer.from([0])]))).toBeUndefined(); // trailing byte
    expect(decodeMemo(b.subarray(0, b.length - 1))).toBeUndefined(); // truncated
    expect(decodeMemo(Buffer.from([0x43, 1, 2, 3]))).toBeUndefined(); // byte string, not text
    expect(decodeMemo(Buffer.from([0x62, 0xff, 0xfe]))).toBeUndefined(); // invalid UTF-8
    expect(decodeMemo(new Uint8Array())).toBeUndefined();
    expect(() => encodeMemo("x".repeat(300))).toThrow(/max 256/);
  });

  it("matches the SDK's CBOR string memo and reads the u16-length DataBlob form", () => {
    expect(Buffer.from(encodeMemo(memo)).equals(Buffer.from(CborMemo.fromString(memo).content))).toBe(true);
    const b = encodeMemo(memo);
    const blob = Buffer.concat([Buffer.from([0, b.length]), b]);
    expect(decodeMemoBlob(blob)).toBe(memo);
    expect(decodeMemoBlob(b)).toBe(memo);
  });
});

describe("live chain reader returns transfer memos (stubbed gRPC)", () => {
  const acct = () => AccountAddress.fromBuffer(new Uint8Array(randomBytes(32)).buffer);
  const [A, B] = [acct(), acct()];
  const reader = (summary: unknown) =>
    new ConcordiumChainReader(loadConfig({ SIGNET_NETWORK: "testnet" }), { getBlockItemStatus: async () => ({ status: TransactionStatusEnum.Finalized, outcome: { summary } }) } as any);

  it("decodes a CCD transfer-with-memo, raw or length-prefixed", async () => {
    const b = Buffer.from(encodeMemo(memo));
    for (const hex of [b.toString("hex"), Buffer.concat([Buffer.from([0, b.length]), b]).toString("hex")]) {
      const s = { transactionType: TransactionKindString.TransferWithMemo, sender: A, transfer: { tag: TransactionEventTag.Transferred, to: B, amount: { microCcdAmount: 5n } }, memo: { tag: TransactionEventTag.TransferMemo, memo: hex } };
      expect((await reader(s).transfers("ab".repeat(32)))?.[0].memo).toBe(memo);
    }
  });

  it("decodes a PLT transfer event memo", async () => {
    const ev = { tag: TransactionEventTag.TokenTransfer, from: { address: A }, to: { address: B }, tokenId: { value: "EURD" }, amount: { value: "5" }, memo: CborMemo.fromString(memo) };
    const s = { transactionType: TransactionKindString.TokenUpdate, events: [ev] };
    expect((await reader(s).transfers("ab".repeat(32)))?.[0].memo).toBe(memo);
  });
});

describe("order memo in the protocol", () => {
  let s: Scenario;
  afterEach(() => s?.close());

  it("merchant asks for the order's memo and settles a payment that carries it", async () => {
    s = await buildMockScenario();
    const q = await quote(s);
    expect(q.req.extra.memo).toBe(orderMemo(q.offer.orderHash));
    const r = await post(s, q.offer.order.id, (await craftPay(s, q)).headers);
    expect(r.status).toBe(200);
    expect(s.world.transfers.get(r.body.txHash)?.memo).toBe(orderMemo(q.offer.orderHash));
  });

  it("merchant refuses a payment signed for another order, or with no memo", async () => {
    s = await buildMockScenario();
    const a = await quote(s);
    const b = await quote(s);
    const rail = s.world.rail(s.kitAccount.address);
    const forA = await rail.createPayment(a.req); // same amount, payee and asset as b
    const r1 = await post(s, b.offer.order.id, (await craftPay(s, b, { payment: forA })).headers);
    expect(r1.status).toBe(403);
    expect(r1.body.reasons).toContain("payment_invalid:memo_mismatch");
    const c = await quote(s); // a refused order is used up, so try the bare payment on a fresh one
    const { memo: _m, ...noMemo } = c.req.extra;
    const bare = await rail.createPayment({ ...c.req, extra: noMemo });
    const r2 = await post(s, c.offer.order.id, (await craftPay(s, c, { payment: bare })).headers);
    expect(r2.status).toBe(403);
    expect(r2.body.reasons).toContain("payment_invalid:memo_mismatch");
  });

  it("buyer refuses to sign when the merchant's memo is not this order", async () => {
    s = await buildMockScenario();
    const realFetch = fetch;
    (s.kit as any).f = async (input: any, init?: any) => {
      const res = await realFetch(input, init);
      const h = res.headers.get(H.paymentRequired);
      if (!h) return res;
      const pr = decodePaymentRequiredHeader(h);
      pr.accepts[0].extra = { ...pr.accepts[0].extra, memo: orderMemo(sha256Hex("some other order")) };
      const headers = new Headers(res.headers);
      headers.set(H.paymentRequired, encodePaymentRequiredHeader(pr));
      return new Response(await res.text(), { status: res.status, headers });
    };
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status).toBe("denied");
    expect(o.status === "denied" && o.reasons).toContain("merchant_not_verified");
    expect(s.world.transfers.size).toBe(0);
  });

  it("receipt check requires the on-chain transfer to name the receipt's order", async () => {
    s = await buildMockScenario();
    const a = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    if (a.status !== "paid") throw new Error("setup purchase failed");
    await anchorPending(s.merchantLedger, s.world.anchorSink(s.shop.address), s.shopBadge);
    const proof = (await fetchReceiptProof(s.shopUrl, a.receipt.orderId))!;
    const deps = { registry: s.world.registry(), verifier: s.world.verifier(), chain: s.world.chainReader() };
    expect((await verifyReceipt(proof, deps)).checks.payment_on_chain.ok).toBe(true);
    // A merchant re-points a real payment at a different order: amount, payer and payee all still match.
    const forged = await signReceipt({ ...receiptBody(proof.receipt), orderHash: sha256Hex("other order") }, s.world.prover(s.shop.address));
    expect((await verifyReceipt({ ...proof, receipt: forged }, deps)).checks.payment_on_chain).toEqual({ ok: false, detail: "payment_memo_not_order" });
    // A transfer without the memo does not back the receipt either.
    s.world.transfers.get(proof.receipt.txHash)!.memo = undefined;
    expect((await verifyReceipt(proof, deps)).checks.payment_on_chain).toEqual({ ok: false, detail: "payment_memo_not_order" });
  });
});
