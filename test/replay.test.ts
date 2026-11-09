import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { H, type SignetOffer } from "../src/core/protocol.js";
import { buildMockScenario, USDR, type Scenario } from "../demo/scenario.js";
import { craftPay, post, quote } from "./helpers.js";

const BREAD = USDR(2.5);

describe("single-use orders and payments", () => {
  let s: Scenario;
  afterEach(() => {
    vi.useRealTimers();
    s?.close();
  });

  it("refuses to pay the same order twice", async () => {
    s = await buildMockScenario();
    const q = await quote(s);
    expect((await post(s, q.offer.order.id, (await craftPay(s, q)).headers)).status).toBe(200);
    const again = await post(s, q.offer.order.id, (await craftPay(s, q)).headers);
    expect(again.status).toBe(409);
    expect(again.body.reasons).toEqual(["order_already_paid"]);
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150) - BREAD);
  });

  it("settles once when the same pay request arrives twice at the same moment", async () => {
    s = await buildMockScenario();
    s.world.settleLatencyMs = 100; // the first request is still settling when the second arrives
    const q = await quote(s);
    const { headers } = await craftPay(s, q);
    const results = await Promise.all([post(s, q.offer.order.id, headers), post(s, q.offer.order.id, headers)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.reasons).toEqual(["order_already_used"]);
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150) - BREAD);
  });

  it("refuses a signed payment replayed on a second order with the same price", async () => {
    s = await buildMockScenario();
    const a = await quote(s);
    const b = await quote(s);
    const first = await craftPay(s, a);
    expect((await post(s, a.offer.order.id, first.headers)).status).toBe(200);
    const r = await post(s, b.offer.order.id, (await craftPay(s, b, { payment: first.payment, spent: BREAD })).headers);
    expect(r.status).toBe(409);
    expect(r.body.reasons).toEqual(["payment_replayed"]);
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150) - BREAD);
  });

  it("the chain itself refuses a transaction settled before (mock nonce)", async () => {
    s = await buildMockScenario();
    const rail = s.world.rail(s.kitAccount.address);
    const req = await rail.requirements({ payTo: s.shop.address, asset: "USDR", amount: BREAD });
    const p = await rail.createPayment(req);
    expect((await rail.settle(p, req)).success).toBe(true);
    expect(await rail.settle(p, req)).toMatchObject({ success: false, errorReason: "duplicate_transaction" });
  });

  it("a refused attempt uses up the order: no retry with patched evidence", async () => {
    s = await buildMockScenario();
    const q = await quote(s);
    expect((await post(s, q.offer.order.id, (await craftPay(s, q, { mandate: null })).headers)).status).toBe(403);
    const retry = await post(s, q.offer.order.id, (await craftPay(s, q)).headers);
    expect(retry.status).toBe(409);
    expect(retry.body.reasons).toEqual(["order_already_used"]);
  });

  it("refuses an order paid after its challenge expired", async () => {
    s = await buildMockScenario();
    const q = await quote(s);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q)).headers);
    expect(r.status).toBe(410);
    expect(r.body.reasons).toEqual(["order_expired"]);
  });
});

describe("session-bound challenges", () => {
  let s: Scenario;
  afterEach(() => s?.close());

  it("offers carry one session in both directions", async () => {
    s = await buildMockScenario();
    const { offer } = await quote(s);
    expect(offer.session).toMatch(/^ses_/);
    expect(offer.challenge.session).toBe(offer.session);
    expect(offer.merchantProof.challenge.session).toBe(offer.session);
  });

  it("merchant refuses a buyer proof signed for a different session", async () => {
    s = await buildMockScenario();
    const q = await quote(s);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { challenge: { ...q.offer.challenge, session: "ses_attacker" } })).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("session_mismatch");
  });

  it("merchant refuses a proof from another session of the same buyer, even for an identical basket", async () => {
    s = await buildMockScenario();
    const a = await quote(s);
    const b = await quote(s);
    const r = await post(s, b.offer.order.id, (await craftPay(s, b, { challenge: a.offer.challenge })).headers);
    expect(r.body.reasons).toEqual(expect.arrayContaining(["session_mismatch", "nonce_mismatch"]));
  });

  /** A man in the middle edits the offer the buyer receives. */
  function rewritingFetch(edit: (o: SignetOffer) => void): typeof fetch {
    return async (input, init) => {
      const r = await fetch(input, init);
      const h = r.headers.get(H.paymentRequired);
      if (!h) return r;
      const pr = decodePaymentRequiredHeader(h);
      edit(pr.extensions!.signet as SignetOffer);
      const headers = new Headers(r.headers);
      headers.set(H.paymentRequired, encodePaymentRequiredHeader(pr));
      return new Response(await r.text(), { status: r.status, headers });
    };
  }

  it("buyer will not sign a challenge addressed to another merchant (relay)", async () => {
    s = await buildMockScenario();
    (s.kit as any).f = rewritingFetch((o) => (o.challenge.audience = "MockSomeOtherShop"));
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status === "denied" && o.stage).toBe("merchant");
    expect(o.status === "denied" && s.kitLedger.all.find((e) => e.type === "counterparty_check")!.data.issues).toContain("challenge_audience_not_merchant");
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150));
  });

  it("buyer refuses an offer whose challenge and merchant proof are from different sessions", async () => {
    s = await buildMockScenario();
    (s.kit as any).f = rewritingFetch((o) => (o.challenge.session = "ses_other"));
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status).toBe("denied");
    expect(s.kitLedger.all.find((e) => e.type === "counterparty_check")!.data.issues).toContain("challenge_session_mismatch");
  });
});
