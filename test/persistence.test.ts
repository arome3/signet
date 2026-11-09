import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MerchantStore } from "../src/seller/store.js";
import { buildMockScenario, USDR, type Scenario } from "../demo/scenario.js";
import { craftPay, post, quote } from "./helpers.js";

describe("merchant state survives restarts", () => {
  let s: Scenario;
  let dir: string;
  const stateFile = () => join(dir, "merchant-state.json");
  const setup = async (persist = true) => {
    dir = mkdtempSync(join(tmpdir(), "signet-state-"));
    s = await buildMockScenario({ shopStateFile: persist ? stateFile() : undefined });
  };
  afterEach(() => {
    s?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a replayed paid order after a restart", async () => {
    await setup();
    const q = await quote(s);
    const { headers } = await craftPay(s, q);
    expect((await post(s, q.offer.order.id, headers)).status).toBe(200);
    await s.restartShop();
    const replay = await post(s, q.offer.order.id, headers);
    expect(replay.status).toBe(409);
    expect(replay.body.reasons).toEqual(["order_already_paid"]);
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150) - USDR(2.5));
  });

  it("refuses a used payment signature on a new order after a restart", async () => {
    await setup();
    const a = await quote(s);
    const first = await craftPay(s, a);
    expect((await post(s, a.offer.order.id, first.headers)).status).toBe(200);
    await s.restartShop();
    const b = await quote(s);
    const r = await post(s, b.offer.order.id, (await craftPay(s, b, { payment: first.payment, spent: USDR(2.5) })).headers);
    expect(r.body.reasons).toEqual(["payment_replayed"]);
  });

  it("remembers spend received per agent: an understated statement after a restart is refused", async () => {
    await setup();
    expect((await s.kit.purchase(s.shopUrl, [{ sku: "eggs", qty: 5 }])).status).toBe("paid");
    await s.restartShop();
    const q = await quote(s, [{ sku: "eggs", qty: 5 }]);
    const r = await post(s, q.offer.order.id, (await craftPay(s, q, { spent: 0n })).headers);
    expect(r.body.reasons).toContain("spend_understated");
  });

  it("without a state file, a restart forgets spend received (the gap persistence closes)", async () => {
    await setup(false);
    expect((await s.kit.purchase(s.shopUrl, [{ sku: "eggs", qty: 5 }])).status).toBe("paid");
    await s.restartShop();
    const q = await quote(s, [{ sku: "eggs", qty: 5 }]);
    expect((await post(s, q.offer.order.id, (await craftPay(s, q, { spent: 0n })).headers)).status).toBe(200);
  });

  it("an order caught in flight by a crash is never paid after the restart", async () => {
    await setup();
    const q = await quote(s);
    const st = JSON.parse(readFileSync(stateFile(), "utf8"));
    st.orders[q.offer.order.id].state = "in_flight"; // crashed after claiming, before the outcome was written
    writeFileSync(stateFile(), JSON.stringify(st));
    await s.restartShop();
    const r = await post(s, q.offer.order.id, (await craftPay(s, q)).headers);
    expect(r.status).toBe(409);
    expect(r.body.reasons).toEqual(["order_already_used"]);
  });

  it("serves receipts for orders paid before the restart", async () => {
    await setup();
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    await s.restartShop();
    const r = await fetch(new URL(`/receipts/${o.status === "paid" ? o.receipt.orderId : ""}`, s.shopUrl));
    expect(r.status).toBe(202); // known and paid, waiting for its log batch to be anchored
  });

  it("writes atomically (no temp files left) and refuses to start on a corrupt file", async () => {
    await setup();
    await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(readdirSync(dir)).toEqual(["merchant-state.json"]);
    expect(JSON.parse(readFileSync(stateFile(), "utf8")).v).toBe(1);
    writeFileSync(stateFile(), '{"v":1,"orders":{'); // torn write
    expect(() => new MerchantStore(stateFile())).toThrow(/refusing to start/);
    await expect(s.restartShop()).rejects.toThrow(/refusing to start/);
  });
});
