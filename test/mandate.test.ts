import { afterEach, describe, expect, it } from "vitest";
import { AutoConsent } from "../src/core/consent.js";
import { evaluateMandate, mandateHash, signMandate, signSpend, utcDay } from "../src/core/mandate.js";
import { signAs } from "../src/core/signing.js";
import { adaMandate, buildMockScenario, USDR, type Scenario } from "../demo/scenario.js";
import { craftPay, post, quote } from "./helpers.js";

/** Over the 20 USDR per-payment limit, not age-restricted: the mandate says "ask the owner". */
const OVER_LIMIT = [{ sku: "eggs", qty: 7 }];

describe("owner-signed mandate (unit)", () => {
  it("only the named owner can sign", async () => {
    const s = await buildMockScenario();
    try {
      const m = adaMandate(s.kitBadge, s.ada.address);
      await expect(signMandate(m, s.world.prover(s.kitAccount.address))).rejects.toThrow(/owner/);
    } finally {
      s.close();
    }
  });

  it("is not in force before validFrom", () => {
    const m = { ...adaMandate("KitBadge01", "ada01"), validFrom: new Date(Date.now() + 86400_000).toISOString() };
    const intent = { merchant: { badge: "Shop", verified: true, business: true }, asset: "USDR", amount: USDR(1), categories: ["groceries"], description: "" };
    expect(evaluateMandate(m, intent, 0n).reasons).toContain("mandate_not_yet_valid");
  });
});

describe("merchant-side mandate check (compromised buyer runtime)", () => {
  let s: Scenario;
  afterEach(() => s?.close());

  it("refuses payment when the agent sends no mandate", async () => {
    s = await buildMockScenario();
    const q = await quote(s);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { mandate: null })).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("mandate_missing");
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150));
  });

  it("re-runs the mandate itself: blocked category is refused even if the buyer skipped its check", async () => {
    s = await buildMockScenario();
    const q = await quote(s, [{ sku: "cigarettes", qty: 1 }]);
    const attest = [await s.world.attributeProver(s.kitAccount.address).prove("age_over", 18, q.offer.challenge.nonce)];
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { attest })).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("mandate:category_blocked:tobacco");
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150));
  });

  it("refuses a mandate the agent re-signed with raised limits", async () => {
    s = await buildMockScenario();
    const raised = { ...s.signedMandate.mandate, hardLimit: USDR(10_000).toString(), perPaymentLimit: USDR(10_000).toString() };
    const forged = { mandate: raised, ownerSignature: await signAs(s.world.prover(s.kitAccount.address), "signet-mandate", { mandateHash: mandateHash(raised) }) };
    const q = await quote(s, OVER_LIMIT);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { mandate: forged })).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toEqual(expect.arrayContaining(["mandate_signer_not_owner", "mandate_hash_not_published_value"]));
  });

  it("refuses an edited mandate that keeps the owner's original signature", async () => {
    s = await buildMockScenario();
    const edited = { mandate: { ...s.signedMandate.mandate, blockedCategories: [] }, ownerSignature: s.signedMandate.ownerSignature };
    const q = await quote(s);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { mandate: edited })).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toEqual(expect.arrayContaining(["mandate_bad_signature", "mandate_hash_not_published_value"]));
  });

  it("refuses a valid mandate that belongs to another agent", async () => {
    s = await buildMockScenario();
    const otherAgent = s.world.registerAgent(s.kitAccount.address);
    const theirs = await signMandate(adaMandate(otherAgent, s.ada.address), s.world.prover(s.ada.address));
    const q = await quote(s);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { mandate: theirs })).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("mandate_wrong_agent");
  });

  it("refuses a mandate whose hash the badge does not publish, on both sides", async () => {
    s = await buildMockScenario();
    s.world.agents.get(s.kitBadge)!.metadata = {};
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status === "denied" && o.stage).toBe("mandate");
    expect(o.status === "denied" && o.reasons).toContain("mandate_not_published");
    const q = await quote(s);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q)).headers);
    expect(r.body.reasons).toContain("mandate_not_published");
  });

  it("refuses an expired owner-signed mandate", async () => {
    s = await buildMockScenario();
    const old = { ...adaMandate(s.kitBadge, s.ada.address), validUntil: new Date(Date.now() - 1000).toISOString() };
    s.world.publishMandate(s.kitBadge, mandateHash(old));
    const q = await quote(s);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { mandate: await signMandate(old, s.world.prover(s.ada.address)) })).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("mandate:mandate_expired");
  });

  it("requires a verifiable owner approval when the order is outside the mandate", async () => {
    s = await buildMockScenario();
    const q = await quote(s, OVER_LIMIT);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q)).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("approval_required");
  });

  it("refuses an unsigned 'approved' flag and an approval the agent signed itself", async () => {
    s = await buildMockScenario();
    const ask = (q: Awaited<ReturnType<typeof quote>>) => ({
      orderId: q.offer.order.id, orderHash: q.offer.orderHash, agent: s.kitBadge, owner: s.ada.address, merchantBadge: s.shopBadge,
      amount: BigInt(q.req.amount), asset: "USDR", summary: "eggs", reasons: ["per_payment_limit_exceeded"],
    });
    const q1 = await quote(s, OVER_LIMIT);
    const unsigned = await new AutoConsent(true).request(ask(q1));
    expect((await post(s, q1.offer.order.id, (await craftPay(s, q1, { consent: unsigned })).headers)).body.reasons).toContain("approval_unverifiable");

    const q2 = await quote(s, OVER_LIMIT);
    const selfSigned = { ...unsigned, ownerSignature: await signAs(s.world.prover(s.kitAccount.address), "signet-approval", { orderHash: q2.offer.orderHash }) };
    expect((await post(s, q2.offer.order.id, (await craftPay(s, q2, { consent: selfSigned })).headers)).body.reasons).toContain("approval_bad_signature");
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150));
  });

  it("refuses the owner's approval of one order replayed on another", async () => {
    s = await buildMockScenario();
    const owner = new AutoConsent(true, s.world.prover(s.ada.address));
    const qa = await quote(s, OVER_LIMIT);
    const approvalA = await owner.request({
      orderId: qa.offer.order.id, orderHash: qa.offer.orderHash, agent: s.kitBadge, owner: s.ada.address, merchantBadge: s.shopBadge,
      amount: BigInt(qa.req.amount), asset: "USDR", summary: "eggs", reasons: [],
    });
    const qb = await quote(s, OVER_LIMIT);
    const r = await post(s, qb.offer.order.id, (await craftPay(s, qb, { consent: approvalA })).headers);
    expect(r.body.reasons).toContain("approval_bad_signature");
    // The same approval does work for the order it was given for.
    expect((await post(s, qa.offer.order.id, (await craftPay(s, qa, { consent: approvalA })).headers)).status).toBe(200);
  });

  it("refuses a spend statement below what the merchant itself received today", async () => {
    s = await buildMockScenario();
    expect((await s.kit.purchase(s.shopUrl, [{ sku: "eggs", qty: 5 }])).status).toBe("paid"); // 16 USDR
    const q = await quote(s, [{ sku: "eggs", qty: 5 }]); // another 16: over the 50/day only if spend is told truthfully
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { spent: 0n })).headers);
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("spend_understated");
  });

  it("uses the stated spend-so-far: a true statement over the daily limit needs approval", async () => {
    s = await buildMockScenario();
    const q = await quote(s, [{ sku: "eggs", qty: 5 }]);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { spent: USDR(40) })).headers);
    expect(r.body.reasons).toContain("approval_required");
  });

  it("refuses a spend statement signed by another account or for another order", async () => {
    s = await buildMockScenario();
    const q = await quote(s);
    const st = { agent: s.kitBadge, asset: "USDR", day: utcDay(), spent: "0", orderHash: q.offer.orderHash };
    const byAda = await signSpend(st, s.world.prover(s.ada.address));
    expect((await post(s, q.offer.order.id, (await craftPay(s, q, { spend: byAda })).headers)).body.reasons).toContain("spend_bad_signature");
    const q2 = await quote(s);
    const otherOrder = await signSpend(st, s.world.prover(s.kitAccount.address));
    expect((await post(s, q2.offer.order.id, (await craftPay(s, q2, { spend: otherOrder })).headers)).body.reasons).toContain("spend_wrong_order");
  });

  it("accepts a correctly built payment (control case)", async () => {
    s = await buildMockScenario();
    const q = await quote(s);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q)).headers);
    expect(r.status).toBe(200);
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150) - USDR(2.5));
  });
});
