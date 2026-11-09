import { afterEach, describe, expect, it } from "vitest";
import { brandKey, buildDirectory, checkMerchantListing, checkPrices, endpointOnDomain, signListing, type Listing } from "../src/core/directory.js";
import type { Order } from "../src/core/protocol.js";
import { catalogListing } from "../src/seller/merchant.js";
import { buildMockScenario, CATALOG, USDR, type Scenario } from "../demo/scenario.js";

const listing: Listing = catalogListing({ badge: "MockShop", name: "FreshMart", domain: "freshmart.example", asset: "USDR", catalog: CATALOG }, "https://shop.freshmart.example");
const order = (lines: Order["lines"], extra: Partial<Order> = {}): Order => ({
  id: "ord_1",
  merchant: "MockShop",
  lines,
  total: lines.reduce((t, l) => t + BigInt(l.unitPrice) * BigInt(l.qty), 0n).toString(),
  asset: "USDR",
  categories: [...new Set(lines.map((l) => l.category))],
  createdAt: new Date().toISOString(),
  ...extra,
});
const bread = (qty = 1, unitPrice = USDR(2.5).toString(), category = "groceries") => ({ sku: "bread", name: "Sourdough loaf", qty, unitPrice, category });

describe("listed price vs asked price (unit)", () => {
  it("accepts an order that matches the listing and the request", () => {
    expect(checkPrices(order([bread(2)]), listing, [{ sku: "bread", qty: 2 }])).toEqual([]);
  });
  it("flags a price above the listed price", () => {
    expect(checkPrices(order([bread(1, USDR(25).toString())]), listing, [{ sku: "bread", qty: 1 }])).toContain("price_mismatch:bread");
  });
  it("flags extra items the buyer did not ask for (upsell) and changed quantities", () => {
    const wine = { sku: "wine", name: "Rioja", qty: 1, unitPrice: USDR(12).toString(), category: "alcohol" };
    expect(checkPrices(order([bread(1), wine]), listing, [{ sku: "bread", qty: 1 }])).toContain("order_lines_mismatch");
    expect(checkPrices(order([bread(3)]), listing, [{ sku: "bread", qty: 1 }])).toContain("order_lines_mismatch");
  });
  it("flags a total that is not the sum of the lines, and unlisted items", () => {
    expect(checkPrices(order([bread(1)], { total: USDR(3).toString() }), listing, [{ sku: "bread", qty: 1 }])).toContain("total_mismatch");
    const caviar = { sku: "caviar", name: "Caviar", qty: 1, unitPrice: "1", category: "groceries" };
    expect(checkPrices(order([caviar]), listing, [{ sku: "caviar", qty: 1 }])).toContain("item_not_listed:caviar");
  });
  it("flags a relabelled category (cigarettes sold as groceries) and hidden order categories", () => {
    const cigs = { sku: "cigarettes", name: "Cigarettes x20", qty: 1, unitPrice: USDR(9).toString(), category: "groceries" };
    expect(checkPrices(order([cigs]), listing, [{ sku: "cigarettes", qty: 1 }])).toContain("category_mismatch:cigarettes");
    const honest = { ...cigs, category: "tobacco" };
    expect(checkPrices(order([honest], { categories: ["groceries"] }), listing, [{ sku: "cigarettes", qty: 1 }])).toContain("categories_mismatch");
  });
  it("flags another asset", () => {
    expect(checkPrices(order([bread(1)], { asset: "EURQ" }), listing, [{ sku: "bread", qty: 1 }])).toContain("asset_not_listed");
  });
});

describe("brand and domain rules (unit)", () => {
  it("treats case, spacing and punctuation as the same brand", () => {
    for (const b of ["FreshMart", "fresh mart", "Fresh-Mart", "FRESHMART", "Fresh Mart!"]) expect(brandKey(b), b).toBe("freshmart");
    expect(brandKey("FreshMarket")).not.toBe("freshmart");
  });
  it("requires https endpoints on the listed domain or a subdomain", () => {
    expect(endpointOnDomain("https://freshmart.example/shop", "freshmart.example")).toBe(true);
    expect(endpointOnDomain("https://api.freshmart.example", "freshmart.example")).toBe(true);
    expect(endpointOnDomain("https://freshmart.example.evil.test", "freshmart.example")).toBe(false);
    expect(endpointOnDomain("https://evilfreshmart.example", "freshmart.example")).toBe(false);
    expect(endpointOnDomain("http://freshmart.example", "freshmart.example")).toBe(false);
    expect(endpointOnDomain("http://127.0.0.1:4021", "freshmart.example")).toBe(false);
    expect(endpointOnDomain("http://127.0.0.1:4021", "freshmart.example", true)).toBe(true);
  });
});

describe("verified-merchant directory", () => {
  let s: Scenario;
  afterEach(() => s?.close());

  const deps = (s: Scenario, allowLoopbackEndpoints = true) => ({ registry: s.world.registry(), verifier: s.world.verifier(), domains: s.world.domainVerifier(), allowLoopbackEndpoints });

  /** A real, verified business with its own badge and DNS, trying to list under some brand. */
  async function business(s: Scenario, brand: string, domain: string) {
    const acc = s.world.createAccount("business");
    const badge = s.world.registerAgent(acc.address);
    s.world.proveDomain(domain, acc.address);
    const l = catalogListing({ badge, name: brand, domain, asset: "USDR", catalog: CATALOG }, `https://${domain}`);
    return { acc, badge, signed: await signListing(l, s.world.prover(acc.address)) };
  }

  it("the operator refuses the tampered-card impostor that applied as FreshMart", async () => {
    s = await buildMockScenario();
    expect(s.directory.directory.listings.map((l) => l.listing.brand)).toEqual(["FreshMart"]);
    expect(s.refusedListings[0].reasons).toEqual(expect.arrayContaining(["merchant_badge_not_verified", "domain_not_proven", "brand_taken"]));
  });

  it("the operator refuses a verified business using a taken brand, however it is spaced or cased", async () => {
    s = await buildMockScenario();
    const clone = await business(s, "FRESH-mart", "fresh-mart.example");
    const { refused, directory } = await buildDirectory([s.directory.directory.listings[0], clone.signed], s.world.prover(s.operator.address), deps(s));
    expect(directory.directory.listings).toHaveLength(1);
    expect(refused[0].reasons).toEqual(["brand_taken"]);
  });

  it("the operator refuses non-business owners, missing domain proof, off-domain endpoints and listings signed by others", async () => {
    s = await buildMockScenario();
    const human = s.world.createAccount("human");
    const hBadge = s.world.registerAgent(human.address);
    s.world.proveDomain("corner.example", human.address);
    const humanListing = await signListing(catalogListing({ badge: hBadge, name: "Corner", domain: "corner.example", asset: "USDR", catalog: CATALOG }, "https://corner.example"), s.world.prover(human.address));
    const noDns = await business(s, "Bakery", "bakery.example");
    s.world.dnsTxt.clear(); // Bakery loses its proof; Corner keeps its own
    s.world.proveDomain("corner.example", human.address);
    const offDomain = await business(s, "Grocer", "grocer.example");
    offDomain.signed.listing.endpoint = "https://grocer-payments.test";
    const forged = await business(s, "Deli", "deli.example");
    const forgedBy = await signListing(forged.signed.listing, s.world.prover(human.address));
    const { refused } = await buildDirectory([humanListing, noDns.signed, offDomain.signed, forgedBy], s.world.prover(s.operator.address), deps(s, false));
    expect(refused.map((r) => [r.brand, r.reasons])).toEqual([
      ["Corner", ["merchant_not_business"]],
      ["Bakery", ["domain_not_proven"]],
      ["Grocer", ["bad_listing_signature", "endpoint_not_on_domain"]],
      ["Deli", ["bad_listing_signature"]],
    ]);
  });

  it("buyer refuses a verified business that is not in the directory (cloned shop)", async () => {
    s = await buildMockScenario();
    const clone = await business(s, "FreshMart", "freshmart-deals.example");
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]); // control: listed shop works
    expect(o.status).toBe("paid");
    const res = await checkMerchantListing(s.directory, s.operator.address, { badge: clone.badge, name: "FreshMart", domain: "freshmart-deals.example", contactedUrl: "https://freshmart-deals.example" }, deps(s));
    expect(res.issues).toEqual(["merchant_not_listed"]);
  });

  it("buyer refuses a directory the operator did not sign, or that someone extended", async () => {
    s = await buildMockScenario();
    const clone = await business(s, "FreshMart Express", "fmx.example");
    const extended = { ...s.directory, directory: { ...s.directory.directory, listings: [...s.directory.directory.listings, clone.signed] } };
    const answered = { badge: clone.badge, name: "FreshMart Express", domain: "fmx.example", contactedUrl: "https://fmx.example" };
    expect((await checkMerchantListing(extended, s.operator.address, answered, deps(s))).issues).toEqual(["directory_bad_signature"]);
    const byOther = await buildDirectory([clone.signed], s.world.prover(clone.acc.address), deps(s));
    expect((await checkMerchantListing(byOther.directory, s.operator.address, answered, deps(s))).issues).toEqual(["directory_bad_signature"]);
  });

  it("buyer refuses brand or domain shown differently from the listing, and a directory with look-alike brands", async () => {
    s = await buildMockScenario();
    const shop = s.directory.directory.listings[0].listing;
    const base = { badge: shop.badge, name: "FreshMart", domain: "freshmart.example", contactedUrl: shop.endpoint };
    expect((await checkMerchantListing(s.directory, s.operator.address, base, deps(s))).issues).toEqual([]);
    expect((await checkMerchantListing(s.directory, s.operator.address, { ...base, name: "FreshMart Organic" }, deps(s))).issues).toEqual(["brand_mismatch"]);
    expect((await checkMerchantListing(s.directory, s.operator.address, { ...base, name: "ＦｒｅｓｈＭａｒｔ" }, deps(s))).issues).toEqual(["brand_mismatch"]);
    expect((await checkMerchantListing(s.directory, s.operator.address, { ...base, domain: "freshmart.test" }, deps(s))).issues).toEqual(["domain_mismatch"]);
    // A careless operator lists a look-alike: the buyer still sees two holders of one brand.
    const clone = await business(s, "FRESH-MART", "fm2.example");
    const careless = { directory: { ...s.directory.directory, listings: [...s.directory.directory.listings, clone.signed] }, operatorSignature: undefined as any };
    const { signAs } = await import("../src/core/signing.js");
    careless.operatorSignature = await signAs(s.world.prover(s.operator.address), "signet-directory", careless.directory);
    expect((await checkMerchantListing(careless, s.operator.address, base, deps(s))).issues).toContain("brand_conflict");
  });

  it("buyer refuses when the domain proof is withdrawn", async () => {
    s = await buildMockScenario();
    s.world.dnsTxt.clear();
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status === "denied" && o.reasons).toContain("domain_not_proven");
  });

  it("buyer refuses to pay the real shop's offer relayed through another URL", async () => {
    s = await buildMockScenario();
    const shopUrl = s.shopUrl;
    (s.kit as any).f = (input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace("http://evil.example", shopUrl), init);
    const o = await s.kit.purchase("http://evil.example", [{ sku: "bread", qty: 1 }]);
    expect(o.status === "denied" && o.stage).toBe("merchant");
    expect(o.status === "denied" && o.reasons).toContain("endpoint_not_listed");
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150));
  });

  it("buyer refuses a listed shop that asks more than its listed price (price swap)", async () => {
    s = await buildMockScenario({ shopCatalog: CATALOG.map((c) => (c.sku === "bread" ? { ...c, unitPrice: USDR(25) } : c)) });
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }]);
    expect(o.status === "denied" && o.stage).toBe("merchant");
    expect(o.status === "denied" && o.reasons).toContain("price_mismatch:bread");
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150));
  });

  it("buyer refuses a listed shop that relabels cigarettes as groceries to dodge the mandate", async () => {
    s = await buildMockScenario({ shopCatalog: CATALOG.map((c) => (c.sku === "cigarettes" ? { ...c, category: "groceries", ageRestricted: undefined } : c)) });
    const o = await s.kit.purchase(s.shopUrl, [{ sku: "cigarettes", qty: 1 }]);
    expect(o.status === "denied" && o.reasons).toContain("category_mismatch:cigarettes");
    expect(s.world.balance(s.kitAccount.address, "USDR")).toBe(USDR(150));
  });
});
