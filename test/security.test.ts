import { afterEach, describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { encodeHeader, proveBadge } from "../src/core/challenge.js";
import { H, type SignetOffer } from "../src/core/protocol.js";
import { buildMockScenario, type Scenario } from "../demo/scenario.js";

/** Attacks a buyer or merchant could try against the protocol. */
async function quote(s: Scenario, badge: string, nonce = "n1", url = s.shopUrl) {
  const r = await fetch(new URL("/orders", url), {
    method: "POST",
    headers: { "content-type": "application/json", [H.agent]: badge, [H.nonce]: nonce },
    body: JSON.stringify({ items: [{ sku: "bread", qty: 1 }] }),
  });
  const pr = decodePaymentRequiredHeader(r.headers.get(H.paymentRequired)!);
  return { pr, offer: pr.extensions!.signet as SignetOffer, req: pr.accepts[0] };
}

async function pay(s: Scenario, orderId: string, headers: Record<string, string>) {
  const r = await fetch(new URL(`/orders/${orderId}/pay`, s.shopUrl), { method: "POST", headers });
  return { status: r.status, body: (await r.json()) as any };
}

describe("protocol attacks", () => {
  let s: Scenario;
  afterEach(() => s?.close());

  it("rejects a stolen badge: attacker signs with its own key", async () => {
    s = await buildMockScenario();
    const attacker = s.world.createAccount("agent", { dob: "1990-01-01" });
    s.world.mint(attacker.address, "USDR", 100_000_000n);
    const { offer, req } = await quote(s, s.kitBadge);
    const proof = await proveBadge(s.kitBadge, s.world.prover(attacker.address), offer.challenge);
    const payment = await s.world.rail(attacker.address).createPayment(req);
    const r = await pay(s, offer.order.id, { [H.paymentSignature]: encodePaymentSignatureHeader(payment), [H.proof]: encodeHeader(proof), [H.attest]: encodeHeader([]) });
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("account_not_bound_to_badge");
  });

  it("rejects a proof replayed from another order", async () => {
    s = await buildMockScenario();
    const a = await quote(s, s.kitBadge);
    const b = await quote(s, s.kitBadge);
    const proofForA = await proveBadge(s.kitBadge, s.world.prover(s.kitAccount.address), a.offer.challenge);
    const payment = await s.world.rail(s.kitAccount.address).createPayment(b.req);
    const r = await pay(s, b.offer.order.id, { [H.paymentSignature]: encodePaymentSignatureHeader(payment), [H.proof]: encodeHeader(proofForA), [H.attest]: encodeHeader([]) });
    expect(r.status).toBe(403);
    expect(r.body.reasons).toEqual(expect.arrayContaining(["nonce_mismatch", "order_mismatch"]));
  });

  it("rejects payment from an account other than the proven one", async () => {
    s = await buildMockScenario();
    const other = s.world.createAccount("human");
    s.world.mint(other.address, "USDR", 100_000_000n);
    const { offer, req } = await quote(s, s.kitBadge);
    const proof = await proveBadge(s.kitBadge, s.world.prover(s.kitAccount.address), offer.challenge);
    const payment = await s.world.rail(other.address).createPayment(req);
    const r = await pay(s, offer.order.id, { [H.paymentSignature]: encodePaymentSignatureHeader(payment), [H.proof]: encodeHeader(proof), [H.attest]: encodeHeader([]) });
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("payer_not_badge_account");
  });

  it("rejects a badge revoked between quote and payment", async () => {
    s = await buildMockScenario();
    const { offer, req } = await quote(s, s.kitBadge);
    s.world.revoke(s.kitBadge);
    const proof = await proveBadge(s.kitBadge, s.world.prover(s.kitAccount.address), offer.challenge);
    const payment = await s.world.rail(s.kitAccount.address).createPayment(req);
    const r = await pay(s, offer.order.id, { [H.paymentSignature]: encodePaymentSignatureHeader(payment), [H.proof]: encodeHeader(proof), [H.attest]: encodeHeader([]) });
    expect(r.status).toBe(403);
    expect(r.body.reasons).toContain("revoked");
  });

  it("buyer refuses a merchant whose proof is not over the buyer's nonce", async () => {
    s = await buildMockScenario();
    // Swap the fetch so the buyer sends nonce X but the merchant sees nonce Y (replayed offer).
    const realFetch = fetch;
    const tampering: typeof fetch = (input, init) => {
      const h = new Headers(init?.headers);
      if (h.get(H.nonce)) h.set(H.nonce, "replayed-nonce");
      return realFetch(input, { ...init, headers: h });
    };
    (s.kit as any).f = tampering;
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status).toBe("denied");
    expect(o.status === "denied" && o.reasons).toContain("merchant_not_verified");
  });
});
