import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AutoConsent } from "../src/core/consent.js";
import { AuditLedger } from "../src/core/ledger.js";
import { mandateHash, parseMandate, signMandate, type Mandate } from "../src/core/mandate.js";
import type { ConsentProvider, ConsentRequest } from "../src/core/types.js";
import { SignetBuyer, type PurchaseOutcome } from "../src/buyer/agent.js";
import { buildDirectory, signListing } from "../src/core/directory.js";
import { catalogListing, createMerchantApp, type CatalogItem } from "../src/seller/merchant.js";
import { MockWorld } from "../src/mock/world.js";

export const USDR = (n: number) => BigInt(Math.round(n * 1_000_000));

export const CATALOG: CatalogItem[] = [
  { sku: "bread", name: "Sourdough loaf", unitPrice: USDR(2.5), category: "groceries" },
  { sku: "milk", name: "Whole milk 1L", unitPrice: USDR(1.8), category: "groceries" },
  { sku: "eggs", name: "Free-range eggs x12", unitPrice: USDR(3.2), category: "groceries" },
  { sku: "wine", name: "Rioja red 75cl", unitPrice: USDR(12), category: "alcohol", ageRestricted: 18 },
  { sku: "champagne", name: "Champagne brut 75cl", unitPrice: USDR(45), category: "alcohol", ageRestricted: 18 },
  { sku: "cigarettes", name: "Cigarettes x20", unitPrice: USDR(9), category: "tobacco", ageRestricted: 18 },
];

export function adaMandate(agent: string, owner: string): Mandate {
  return parseMandate({
    version: 1,
    agent,
    owner,
    asset: "USDR",
    perPaymentLimit: USDR(20).toString(),
    dailyLimit: USDR(50).toString(),
    hardLimit: USDR(200).toString(),
    blockedCategories: ["tobacco"],
    merchantPolicy: { requireVerifiedBadge: true, requireBusinessOwner: true },
    validUntil: new Date(Date.now() + 30 * 86400_000).toISOString(),
  });
}

async function listen(app: ReturnType<typeof createMerchantApp>): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

/**
 * Offline world for the demo and tests:
 *  - Ada (human, born 1995) owns "Kit", a shopping agent with its own agent-IDP account.
 *  - FreshMart is a business-verified merchant agent.
 *  - "FreshMart" impostor: registered, but its Agent Card was tampered with.
 *  - Teen-owned agent and an unregistered rogue script.
 */
export async function buildMockScenario(
  opts: {
    consent?: ConsentProvider;
    approve?: boolean | ((r: ConsentRequest) => boolean);
    /** What FreshMart actually charges; its directory listing always shows CATALOG. */
    shopCatalog?: CatalogItem[];
  } = {},
) {
  const world = new MockWorld();

  const ada = world.createAccount("human", { dob: "1995-04-12" });
  // Agent IDP flow: Ada reveals only her date of birth to the agent's identity.
  const kitAccount = world.createAccount("agent", { dob: "1995-04-12" });
  const kitBadge = world.registerAgent(kitAccount.address, { agentWallet: kitAccount.address });
  world.mint(kitAccount.address, "USDR", USDR(150));

  const shop = world.createAccount("business");
  const shopBadge = world.registerAgent(shop.address);

  const fake = world.createAccount("business");
  const fakeBadge = world.registerAgent(fake.address);
  world.tamperCard(fakeBadge);

  const teen = world.createAccount("agent", { dob: "2010-09-01" });
  const teenBadge = world.registerAgent(teen.address, { agentWallet: teen.address });
  world.mint(teen.address, "USDR", USDR(50));

  const merchantLedger = new AuditLedger();
  const merchantApp = createMerchantApp({
    name: "FreshMart",
    domain: "freshmart.example",
    badge: shopBadge,
    payTo: shop.address,
    asset: "USDR",
    catalog: opts.shopCatalog ?? CATALOG,
    prover: world.prover(shop.address),
    rail: world.rail(),
    registry: world.registry(),
    verifier: world.verifier(),
    attributes: world.attributeVerifier(),
    ledger: merchantLedger,
  });
  const fakeApp = createMerchantApp({
    name: "FreshMart",
    domain: "freshmart.example",
    badge: fakeBadge,
    payTo: fake.address,
    asset: "USDR",
    catalog: CATALOG,
    prover: world.prover(fake.address),
    rail: world.rail(),
    registry: world.registry(),
    verifier: world.verifier(),
    attributes: world.attributeVerifier(),
    ledger: new AuditLedger(),
  });
  const shopSrv = await listen(merchantApp);
  const fakeSrv = await listen(fakeApp);

  // Directory: FreshMart proves freshmart.example in DNS and lists its catalog. The impostor also
  // applies as "FreshMart" and is refused. Mock endpoints are loopback, so that is allowed here only.
  world.proveDomain("freshmart.example", shop.address);
  const operator = world.createAccount("business");
  const shopInfo = { badge: shopBadge, name: "FreshMart", domain: "freshmart.example", asset: "USDR", catalog: CATALOG };
  const domains = world.domainVerifier();
  const { directory, refused: refusedListings } = await buildDirectory(
    [
      await signListing(catalogListing(shopInfo, shopSrv.url), world.prover(shop.address)),
      await signListing(catalogListing({ ...shopInfo, badge: fakeBadge }, fakeSrv.url), world.prover(fake.address)),
    ],
    world.prover(operator.address),
    { registry: world.registry(), verifier: world.verifier(), domains, allowLoopbackEndpoints: true },
  );
  const directoryCfg = { listings: directory, operator: operator.address, domains, allowLoopbackEndpoints: true };

  const kitLedger = new AuditLedger();
  // Ada signs Kit's mandate with her own account and publishes its hash on Kit's badge.
  const mandate = adaMandate(kitBadge, ada.address);
  const signedMandate = await signMandate(mandate, world.prover(ada.address));
  world.publishMandate(kitBadge, mandateHash(mandate));
  const kit = new SignetBuyer({
    badge: kitBadge,
    mandate: signedMandate,
    prover: world.prover(kitAccount.address),
    attributes: world.attributeProver(kitAccount.address),
    rail: world.rail(kitAccount.address),
    registry: world.registry(),
    verifier: world.verifier(),
    // Simulated Ada: approves and signs with her key, so FreshMart can check the approval itself.
    consent: opts.consent ?? new AutoConsent(opts.approve ?? true, world.prover(ada.address)),
    ledger: kitLedger,
    directory: directoryCfg,
  });
  kitLedger.append({ type: "mandate_published", actor: kitBadge, data: { mandate: kit.mandateHash, owner: ada.address, asset: mandate.asset, perPaymentLimit: mandate.perPaymentLimit, dailyLimit: mandate.dailyLimit } });

  const teenMandate = adaMandate(teenBadge, teen.address);
  world.publishMandate(teenBadge, mandateHash(teenMandate));
  const teenAgent = new SignetBuyer({
    badge: teenBadge,
    mandate: await signMandate(teenMandate, world.prover(teen.address)),
    prover: world.prover(teen.address),
    attributes: world.attributeProver(teen.address),
    rail: world.rail(teen.address),
    registry: world.registry(),
    verifier: world.verifier(),
    consent: new AutoConsent(true, world.prover(teen.address)),
    ledger: new AuditLedger(),
    directory: directoryCfg,
  });

  const close = () => {
    shopSrv.server.close();
    fakeSrv.server.close();
  };

  return { world, ada, kitAccount, kitBadge, kit, kitLedger, signedMandate, directory, directoryCfg, refusedListings, operator, fake, fakeBadge, shop, shopBadge, shopUrl: shopSrv.url, fakeUrl: fakeSrv.url, merchantLedger, teenAgent, teenBadge, close };
}

export type Scenario = Awaited<ReturnType<typeof buildMockScenario>>;

export interface Step {
  title: string;
  run: (s: Scenario) => Promise<PurchaseOutcome | { status: "http"; code: number; body: unknown }>;
  expect: "paid" | "denied" | "http403";
}

export const STEPS: Step[] = [
  { title: "Weekly groceries (inside the mandate)", expect: "paid", run: (s) => s.kit.purchase(s.shopUrl, [{ sku: "bread", qty: 1 }, { sku: "milk", qty: 2 }, { sku: "eggs", qty: 1 }]) },
  { title: "Bottle of wine (merchant asks for proof the owner is over 18)", expect: "paid", run: (s) => s.kit.purchase(s.shopUrl, [{ sku: "wine", qty: 1 }]) },
  { title: "Champagne for a party (over per-payment and daily limits, owner consent)", expect: "paid", run: (s) => s.kit.purchase(s.shopUrl, [{ sku: "champagne", qty: 1 }]) },
  { title: "Cigarettes (blocked by the owner's mandate)", expect: "denied", run: (s) => s.kit.purchase(s.shopUrl, [{ sku: "cigarettes", qty: 1 }]) },
  { title: "Impostor 'FreshMart' with a tampered Agent Card", expect: "denied", run: (s) => s.kit.purchase(s.fakeUrl, [{ sku: "bread", qty: 1 }]) },
  { title: "Agent whose owner is under 18 tries to buy wine", expect: "denied", run: (s) => s.teenAgent.purchase(s.shopUrl, [{ sku: "wine", qty: 1 }]) },
  {
    title: "Anonymous script with no badge tries to order",
    expect: "http403",
    run: async (s) => {
      const r = await fetch(new URL("/orders", s.shopUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "X-SIGNET-AGENT": "NotARealBadge123", "X-SIGNET-NONCE": "abc" },
        body: JSON.stringify({ items: [{ sku: "bread", qty: 1 }] }),
      });
      return { status: "http", code: r.status, body: await r.json() };
    },
  },
];
