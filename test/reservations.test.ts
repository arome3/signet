import { afterEach, describe, expect, it } from "vitest";
import { AutoConsent } from "../src/core/consent.js";
import type { AttributeProver, ConsentProvider, ConsentRequest, ConsentResult } from "../src/core/types.js";
import { buildMockScenario, USDR, type Scenario } from "../demo/scenario.js";

/** An owner whose answer the test controls: `release()` approves, anything not `waitFor` is declined. */
function gatedOwner(s: Scenario, waitFor: (r: ConsentRequest) => boolean) {
  const signer = new AutoConsent(true, s.world.prover(s.ada.address));
  let asked!: () => void;
  let answer!: (approve: boolean) => void;
  const askedP = new Promise<void>((r) => (asked = r));
  const answerP = new Promise<boolean>((r) => (answer = r));
  const requests: ConsentRequest[] = [];
  const provider: ConsentProvider = {
    async request(r): Promise<ConsentResult> {
      requests.push(r);
      if (!waitFor(r)) return new AutoConsent(false).request(r);
      asked();
      return (await answerP) ? signer.request(r) : new AutoConsent(false).request(r);
    },
  };
  return { provider, asked: askedP, release: (approve = true) => answer(approve), requests };
}

const CHAMPAGNE = [{ sku: "champagne", qty: 1 }]; // 45: over the 20 per-payment limit, needs the owner

describe("spend reservations", () => {
  let s: Scenario;
  afterEach(() => s?.close());

  it("two parallel purchases complete while a third waits for owner approval, and the waiting amount counts", async () => {
    s = await buildMockScenario();
    const owner = gatedOwner(s, (r) => r.amount === USDR(45));
    (s.kit as any).cfg.consent = owner.provider;

    let champagneDone = false;
    const champagne = s.kit.purchase(s.shopUrl, CHAMPAGNE).then((o) => ((champagneDone = true), o));
    await owner.asked;
    expect(s.kit.reservedToday()).toBe(USDR(45));

    const [bread, milk] = await Promise.all([s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]), s.kit.purchase(s.shopUrl, [{ sku: "milk", qty: 1 }])]);
    expect([bread.status, milk.status]).toEqual(["paid", "paid"]);
    expect(champagneDone).toBe(false);

    // 45 held + 4.3 settled + 3.2 = 52.5 > 50/day: the held amount counts, so this one needs the owner (declined here).
    const eggs = await s.kit.purchase(s.shopUrl, [{ sku: "eggs", qty: 1 }]);
    expect(eggs.status === "denied" && eggs.stage).toBe("consent");
    expect(eggs.status === "denied" && eggs.reasons).toContain("daily_limit_exceeded");
    const eggsCheck = s.kitLedger.all.filter((e) => e.type === "mandate_check").at(-1)!;
    expect(eggsCheck.data).toMatchObject({ decision: "consent", spentToday: USDR(45) + USDR(4.3) }); // held at reservation time

    owner.release(true);
    expect((await champagne).status).toBe("paid");
    expect(s.kit.reservedToday()).toBe(0n);
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150) - USDR(45) - USDR(2.5) - USDR(1.8));
  });

  it("a declined approval releases its hold", async () => {
    s = await buildMockScenario();
    const owner = gatedOwner(s, () => true);
    (s.kit as any).cfg.consent = owner.provider;
    const champagne = s.kit.purchase(s.shopUrl, CHAMPAGNE);
    await owner.asked;
    expect(s.kit.reservedToday()).toBe(USDR(45));
    owner.release(false);
    expect((await champagne).status).toBe("denied");
    expect(s.kit.reservedToday()).toBe(0n);
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "eggs", qty: 6 }]); // 19.2, inside the mandate again
    expect(o.status === "paid" && o.evaluation.decision).toBe("allow");
  });

  it("an unanswered approval times out as a refusal and releases its hold", async () => {
    s = await buildMockScenario({ approvalTimeoutMs: 50 });
    (s.kit as any).cfg.consent = { request: () => new Promise(() => {}) } satisfies ConsentProvider;
    const o = await s.kit.purchase(s.shopUrl, CHAMPAGNE);
    expect(o.status === "denied" && o.reasons[0]).toBe("approval_timeout");
    expect(s.kit.reservedToday()).toBe(0n);
    expect(s.kitLedger.all.find((e) => e.type === "consent_result")!.data.method).toBe("timeout");
  });

  it("a merchant refusal releases the hold", async () => {
    s = await buildMockScenario();
    s.world.mustAccount(s.kitAccount.address).balances.set("USDR", 0n);
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status === "denied" && o.reasons).toContain("payment_invalid:insufficient_funds");
    expect(s.kit.reservedToday()).toBe(0n);
  });

  it("keeps the hold when the payment's outcome is unknown", async () => {
    s = await buildMockScenario();
    (s.kit as any).f = (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith("/pay") ? Promise.reject(new Error("connection reset")) : fetch(input, init));
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status === "denied" && o.reasons).toEqual(["payment_outcome_unknown"]);
    expect(s.kit.reservedToday()).toBe(USDR(2.5));
  });

  it("many parallel purchases at one merchant: every spend statement is accepted", async () => {
    s = await buildMockScenario();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }])));
    expect(outcomes.map((o) => (o.status === "denied" ? o.reasons : o.status))).toEqual(Array(6).fill("paid"));
    expect(s.kit.spentToday()).toBe(6n * USDR(2.5));
  });

  it("asks the owner at payment time when a later approved purchase settled first and pushed it over the daily limit", async () => {
    s = await buildMockScenario();
    const owner = new AutoConsent(true, s.world.prover(s.ada.address));
    const asks: ConsentRequest[] = [];
    (s.kit as any).cfg.consent = { request: (r: ConsentRequest) => (asks.push(r), owner.request(r)) } satisfies ConsentProvider;
    // Hold the wine purchase at its age proof (after it has reserved) until the champagne has settled.
    const real: AttributeProver = (s.kit as any).cfg.attributes;
    let releaseWine!: () => void;
    const wineGate = new Promise<void>((r) => (releaseWine = r));
    let first = true;
    (s.kit as any).cfg.attributes = {
      prove: async (...a: Parameters<AttributeProver["prove"]>) => {
        if (first) ((first = false), await wineGate);
        return real.prove(...a);
      },
    } satisfies AttributeProver;

    const wine = s.kit.purchase(s.shopUrl, [{ sku: "wine", qty: 1 }]); // 12: inside the mandate when it starts
    await new Promise((r) => setTimeout(r, 30));
    expect(s.kit.reservedToday()).toBe(USDR(12));
    const champagne = await s.kit.purchase(s.shopUrl, CHAMPAGNE); // 45 + 12 held: owner approves
    expect(champagne.status).toBe("paid");
    releaseWine();
    const w = await wine;
    expect(w.status).toBe("paid"); // now 45 settled + 12 > 50: the owner was asked for the wine too
    expect(w.status === "paid" && w.consent?.approved).toBe(true);
    expect(asks.map((a) => a.amount)).toEqual([USDR(45), USDR(12)]);
    expect(asks[1].reasons).toContain("daily_limit_exceeded");
  });
});
