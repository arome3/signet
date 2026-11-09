import { afterEach, describe, expect, it } from "vitest";
import { brandTextIssues, buildDirectory, checkMerchantListing, domainTextIssues, scriptsOf, signListing } from "../src/core/directory.js";
import { signAs } from "../src/core/signing.js";
import { catalogListing } from "../src/seller/merchant.js";
import { buildMockScenario, CATALOG, type Scenario } from "../demo/scenario.js";

/** Each look-alike renders (nearly) like "FreshMart". */
const CYRILLIC = "FrеshMаrt"; // е U+0435, а U+0430
const GREEK = "FreshΜart"; // Μ U+039C
const FULLWIDTH = "ＦｒｅｓｈＭａｒｔ"; // U+FF26...
const ALL_CYRILLIC = "Фрешмарт";

describe("ASCII and single-script rule (unit)", () => {
  it("detects scripts by letter, ignoring digits and punctuation", () => {
    expect([...scriptsOf("Fresh Mart 24/7")]).toEqual(["Latin"]);
    expect([...scriptsOf(CYRILLIC)].sort()).toEqual(["Cyrillic", "Latin"]);
    expect([...scriptsOf(GREEK)].sort()).toEqual(["Greek", "Latin"]);
    expect([...scriptsOf(FULLWIDTH)]).toEqual(["Latin"]);
  });

  it("refuses Cyrillic, Greek and fullwidth look-alike brands", () => {
    expect(brandTextIssues("FreshMart")).toEqual([]);
    expect(brandTextIssues("Fresh Mart & Co. (24/7)")).toEqual([]);
    expect(brandTextIssues(CYRILLIC)).toEqual(["brand_mixed_script", "brand_non_ascii"]);
    expect(brandTextIssues(GREEK)).toEqual(["brand_mixed_script", "brand_non_ascii"]);
    expect(brandTextIssues(FULLWIDTH)).toEqual(["brand_non_ascii"]);
    expect(brandTextIssues(ALL_CYRILLIC)).toEqual(["brand_non_ascii"]);
  });

  it("refuses accents and invisible characters that NFKC-style matching would hide", () => {
    expect(brandTextIssues("Fresh​Mart")).toEqual(["brand_non_ascii"]); // zero-width space
    expect(brandTextIssues("Fresh­Mart")).toEqual(["brand_non_ascii"]); // soft hyphen
    expect(brandTextIssues("Café")).toEqual(["brand_non_ascii"]);
    expect(brandTextIssues("Café")).toEqual(["brand_non_ascii"]); // combining accent
  });

  it("refuses look-alike and punycode domains", () => {
    expect(domainTextIssues("freshmart.example")).toEqual([]);
    expect(domainTextIssues("frеshmart.example")).toEqual(["domain_mixed_script", "domain_non_ascii"]); // Cyrillic е
    expect(domainTextIssues("freshmαrt.example")).toEqual(["domain_mixed_script", "domain_non_ascii"]); // Greek α
    expect(domainTextIssues("ｆｒｅｓｈｍａｒｔ.example")).toEqual(["domain_non_ascii"]);
    expect(domainTextIssues("xn--frshmart-zng.example")).toEqual(["domain_non_ascii"]);
    expect(domainTextIssues("shop.XN--frshmart-zng.example")).toEqual(["domain_non_ascii"]);
  });

  it("allows exactly the allowlisted strings", () => {
    const allow = { brands: ["Café Nero", ALL_CYRILLIC], domains: ["xn--80aswg.example"] };
    expect(brandTextIssues("Café Nero", allow)).toEqual([]);
    expect(brandTextIssues("Café Nero", allow)).toEqual([]); // same text after NFC
    expect(brandTextIssues(ALL_CYRILLIC, allow)).toEqual([]);
    expect(brandTextIssues("Café Noir", allow)).toEqual(["brand_non_ascii"]);
    expect(domainTextIssues("xn--80aswg.example", allow)).toEqual([]);
    expect(domainTextIssues("xn--80aswg.test", allow)).toEqual(["domain_non_ascii"]);
  });
});

describe("script rule in the directory", () => {
  let s: Scenario;
  afterEach(() => s?.close());

  async function apply(s: Scenario, brand: string, domain: string) {
    const acc = s.world.createAccount("business");
    const badge = s.world.registerAgent(acc.address);
    s.world.proveDomain(domain, acc.address);
    return signListing(catalogListing({ badge, name: brand, domain, asset: "USDR", catalog: CATALOG }, "http://127.0.0.1:1"), s.world.prover(acc.address));
  }
  const deps = (s: Scenario, scriptAllowlist = {}) => ({ registry: s.world.registry(), verifier: s.world.verifier(), domains: s.world.domainVerifier(), allowLoopbackEndpoints: true, scriptAllowlist });

  it("the operator refuses Cyrillic, Greek and fullwidth look-alikes of FreshMart, and look-alike domains", async () => {
    s = await buildMockScenario();
    const apps = [await apply(s, CYRILLIC, "fm1.example"), await apply(s, GREEK, "fm2.example"), await apply(s, FULLWIDTH, "fm3.example"), await apply(s, "Fresh Grocer", "frеshmart.example")];
    const { directory, refused } = await buildDirectory(apps, s.world.prover(s.operator.address), deps(s));
    expect(directory.directory.listings).toEqual([]);
    expect(refused.map((r) => r.reasons)).toEqual([
      ["brand_mixed_script", "brand_non_ascii"],
      ["brand_mixed_script", "brand_non_ascii"],
      ["brand_non_ascii"],
      ["domain_mixed_script", "domain_non_ascii"],
    ]);
  });

  it("an allowlisted non-ASCII brand is listed, and buyers honour the operator's signed allowlist", async () => {
    s = await buildMockScenario();
    const cafe = await apply(s, "Café Nero", "cafenero.example");
    const { directory, refused } = await buildDirectory([cafe], s.world.prover(s.operator.address), deps(s, { brands: ["Café Nero"] }));
    expect(refused).toEqual([]);
    expect(directory.directory.allowlist.brands).toEqual(["Café Nero"]);
    const answered = { badge: cafe.listing.badge, name: "Café Nero", domain: "cafenero.example", contactedUrl: "http://127.0.0.1:1" };
    expect((await checkMerchantListing(directory, s.operator.address, answered, deps(s))).issues).toEqual([]);
    // Someone strips the exception from the directory: the signature no longer holds.
    const stripped = { ...directory, directory: { ...directory.directory, allowlist: { brands: [], domains: [] } } };
    expect((await checkMerchantListing(stripped, s.operator.address, answered, deps(s))).issues).toEqual(["directory_bad_signature"]);
  });

  it("buyer refuses a look-alike listing even if the operator signed it by mistake", async () => {
    s = await buildMockScenario();
    const fake = await apply(s, CYRILLIC, "fm1.example");
    const careless = { v: 1 as const, operator: s.operator.address, issuedAt: new Date().toISOString(), allowlist: {}, listings: [fake] };
    const signed = { directory: careless, operatorSignature: await signAs(s.world.prover(s.operator.address), "signet-directory", careless) };
    const answered = { badge: fake.listing.badge, name: CYRILLIC, domain: "fm1.example", contactedUrl: "http://127.0.0.1:1" };
    expect((await checkMerchantListing(signed, s.operator.address, answered, deps(s))).issues).toEqual(["brand_mixed_script", "brand_non_ascii"]);
  });
});
