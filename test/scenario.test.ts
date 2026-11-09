import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anchorPending } from "../src/core/anchor.js";
import { AutoConsent } from "../src/core/consent.js";
import { buildMockScenario, STEPS, USDR, type Scenario } from "../demo/scenario.js";

describe("end-to-end shopping scenario (mock chain)", () => {
  let s: Scenario;
  const outcomes: any[] = [];
  beforeAll(async () => {
    s = await buildMockScenario();
    for (const step of STEPS) outcomes.push(await step.run(s));
  });
  afterAll(() => s.close());

  it("matches the expected outcome for every step", () => {
    STEPS.forEach((step, i) => {
      const o = outcomes[i];
      if (step.expect === "http403") expect(o.code, step.title).toBe(403);
      else expect(o.status, `${step.title}: ${JSON.stringify(o.reasons ?? "")}`).toBe(step.expect);
    });
  });

  it("asks the owner only for the champagne order", () => {
    expect(outcomes[0].consent).toBeUndefined();
    expect(outcomes[1].consent).toBeUndefined();
    expect(outcomes[2].consent?.approved).toBe(true);
    expect(outcomes[2].evaluation.reasons).toEqual(expect.arrayContaining(["per_payment_limit_exceeded", "daily_limit_exceeded"]));
  });

  it("denies for the right reasons", () => {
    expect(outcomes[3].reasons).toContain("category_blocked:tobacco");
    expect(outcomes[4].stage).toBe("merchant");
    expect(outcomes[4].reasons).toContain("merchant_not_verified");
    expect(outcomes[5].stage).toBe("seller");
    expect(outcomes[5].reasons).toContain("age_over_18_not_proven");
    expect(outcomes[6].body.reasons).toContain("not_registered");
  });

  it("moves exactly the paid amounts", () => {
    const spent = USDR(2.5 + 1.8 * 2 + 3.2) + USDR(12) + USDR(45);
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150) - spent);
    expect(s.world.balance(s.shop.address, "USDR")).toBe(spent);
    expect(s.kit.spentToday()).toBe(spent);
  });

  it("keeps verifiable, anchorable ledgers on both sides", async () => {
    expect(s.kitLedger.verify().ok).toBe(true);
    expect(s.merchantLedger.verify().ok).toBe(true);
    const a = await anchorPending(s.kitLedger, s.world.anchorSink(s.kitAccount.address), s.kitBadge);
    expect(a?.anchor.to).toBe(s.kitLedger.all.length - 1);
    expect(s.world.dataRegistrations).toHaveLength(1);
    expect(await anchorPending(s.kitLedger, s.world.anchorSink(s.kitAccount.address), s.kitBadge)).toBeUndefined();
  });

  it("detects tampering with a past entry", () => {
    const e = s.kitLedger.all[2] as any;
    const old = e.data.decision;
    e.data.decision = "allow-everything";
    expect(s.kitLedger.verify()).toEqual({ ok: false, brokenAt: 2 });
    e.data.decision = old;
  });
});

describe("owner declines", () => {
  it("does not pay when consent is refused", async () => {
    const s = await buildMockScenario({ consent: new AutoConsent(false) });
    try {
      const o = await s.kit.purchase(s.shopUrl, [{ sku: "champagne", qty: 1 }]);
      expect(o.status).toBe("denied");
      expect(o.status === "denied" && o.stage).toBe("consent");
      expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150));
    } finally {
      s.close();
    }
  });
});
