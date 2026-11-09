import type { Order } from "./protocol.js";
import { type AccountSignature, signAs, verifySigned } from "./signing.js";
import type { AccountProver, AccountVerifier, AgentRegistry, DomainVerifier } from "./types.js";

/**
 * Verified-merchant directory (the spec's hackathon shortcut: a static list signed by the directory
 * operator). Each listing is signed by the merchant's badge account and binds together:
 *   badge  <->  brand (one brand per business, no look-alikes)  <->  domain (DNS TXT proof)
 *          <->  endpoint (the URL the buyer talks to)  <->  listed prices and categories.
 * The buyer re-checks all of it at purchase time and compares every quoted line with the listing.
 */
export interface ListedItem {
  sku: string;
  name: string;
  unitPrice: string;
  category: string;
}

export interface Listing {
  v: 1;
  badge: string;
  brand: string;
  domain: string;
  /** Base URL where the merchant takes orders. Its host must be the domain or a subdomain of it. */
  endpoint: string;
  asset: string;
  items: ListedItem[];
  issuedAt: string;
}

export interface SignedListing {
  listing: Listing;
  merchantSignature: AccountSignature;
}

export interface Directory {
  v: 1;
  operator: string;
  issuedAt: string;
  listings: SignedListing[];
}

export interface SignedDirectory {
  directory: Directory;
  operatorSignature: AccountSignature;
}

export async function signListing(listing: Listing, merchant: AccountProver): Promise<SignedListing> {
  return { listing, merchantSignature: await signAs(merchant, "signet-listing", listing) };
}

/** Latin look-alikes that NFKC does not fold (Cyrillic and Greek), enough to stop "FrеshMart". */
const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", μ: "u", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  "0": "o", "1": "l", "3": "e", "5": "s",
};

/** Comparison key for brands: case, spacing, punctuation, digits-for-letters and look-alikes ignored. */
export function brandKey(brand: string): string {
  return [...brand.normalize("NFKC").toLowerCase()]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join("")
    .replace(/[^a-z]/g, "");
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function endpointOnDomain(endpoint: string, domain: string, allowLoopback = false): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (allowLoopback && LOOPBACK.has(u.hostname)) return true;
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const d = domain.toLowerCase();
  return host === d || host.endsWith("." + d);
}

export interface ListingDeps {
  registry: AgentRegistry;
  verifier: AccountVerifier;
  domains: DomainVerifier;
  /** Mock and local development only: accept http://127.0.0.1-style endpoints. */
  allowLoopbackEndpoints?: boolean;
}

/** Checks one listing on its own: merchant signature, verified business badge, domain and endpoint. */
async function checkListing(sl: SignedListing, deps: ListingDeps): Promise<string[]> {
  const l = sl?.listing;
  if (!l || l.v !== 1 || !l.badge || !l.brand || !l.domain || !l.endpoint || !Array.isArray(l.items)) return ["listing_malformed"];
  const issues: string[] = [];
  const v = await deps.registry.check(l.badge);
  if (!v.verified) issues.push("merchant_badge_not_verified");
  if (v.ownerKind !== "business") issues.push("merchant_not_business");
  if (!(await verifySigned(deps.verifier, sl.merchantSignature, "signet-listing", l, [v.owner, v.agentWallet]))) issues.push("bad_listing_signature");
  if (!v.owner || !(await deps.domains.verify(l.domain, v.owner).catch(() => false))) issues.push("domain_not_proven");
  if (!endpointOnDomain(l.endpoint, l.domain, deps.allowLoopbackEndpoints)) issues.push("endpoint_not_on_domain");
  if (!brandKey(l.brand)) issues.push("brand_empty");
  return issues;
}

/**
 * Operator side: vets listings and signs the ones that pass. A brand belongs to the first business
 * owner that lists it; a later listing with the same or a look-alike brand from another owner is
 * refused, and each business owner gets one brand.
 */
export async function buildDirectory(
  listings: SignedListing[],
  operator: AccountProver,
  deps: ListingDeps,
): Promise<{ directory: SignedDirectory; refused: { badge: string; brand: string; reasons: string[] }[] }> {
  const accepted: SignedListing[] = [];
  const refused: { badge: string; brand: string; reasons: string[] }[] = [];
  const brandOwner = new Map<string, string>();
  const ownerBrand = new Map<string, string>();
  for (const sl of listings) {
    const reasons = await checkListing(sl, deps);
    const owner = (await deps.registry.check(sl.listing.badge)).owner ?? "";
    const key = brandKey(sl.listing.brand);
    if (brandOwner.has(key) && brandOwner.get(key) !== owner) reasons.push("brand_taken");
    if (ownerBrand.has(owner) && ownerBrand.get(owner) !== key) reasons.push("owner_already_has_brand");
    if (accepted.some((a) => a.listing.badge === sl.listing.badge)) reasons.push("badge_already_listed");
    if (reasons.length) {
      refused.push({ badge: sl.listing.badge, brand: sl.listing.brand, reasons });
      continue;
    }
    brandOwner.set(key, owner);
    ownerBrand.set(owner, key);
    accepted.push(sl);
  }
  const directory: Directory = { v: 1, operator: operator.account, issuedAt: new Date().toISOString(), listings: accepted };
  return { directory: { directory, operatorSignature: await signAs(operator, "signet-directory", directory) }, refused };
}

/**
 * Buyer side: is the merchant that answered at `contactedUrl` the listed holder of its badge, brand
 * and domain? Trusts only the configured operator account; re-checks every listing fact itself.
 */
export async function checkMerchantListing(
  dir: SignedDirectory | undefined,
  trustedOperator: string,
  answered: { badge: string; name: string; domain?: string; contactedUrl: string },
  deps: ListingDeps,
): Promise<{ issues: string[]; listing?: Listing }> {
  if (!dir?.directory || !Array.isArray(dir.directory.listings)) return { issues: ["directory_missing"] };
  if (dir.directory.operator !== trustedOperator || !(await verifySigned(deps.verifier, dir.operatorSignature, "signet-directory", dir.directory, [trustedOperator])))
    return { issues: ["directory_bad_signature"] };
  const mine = dir.directory.listings.filter((x) => x?.listing?.badge === answered.badge);
  if (mine.length !== 1) return { issues: [mine.length ? "merchant_listed_twice" : "merchant_not_listed"] };
  const sl = mine[0];
  const l = sl.listing;
  const issues = await checkListing(sl, deps);
  const key = brandKey(l.brand);
  if (dir.directory.listings.some((x) => x !== sl && brandKey(x.listing.brand) === key)) issues.push("brand_conflict");
  if (brandKey(answered.name) !== key) issues.push("brand_mismatch");
  if (answered.domain?.toLowerCase() !== l.domain.toLowerCase()) issues.push("domain_mismatch");
  let contactedOrigin = "";
  try {
    contactedOrigin = new URL(answered.contactedUrl).origin;
  } catch {
    /* empty origin never matches */
  }
  if (contactedOrigin !== new URL(l.endpoint).origin) issues.push("endpoint_not_listed");
  return { issues, listing: l };
}

/**
 * Listed price vs asked price. The quoted order must contain exactly the items the buyer asked for,
 * each at its listed unit price and listed category, in the listed asset, adding up to the total.
 */
export function checkPrices(order: Order, listing: Listing, requested: { sku: string; qty: number }[]): string[] {
  const issues: string[] = [];
  if (order.asset !== listing.asset) issues.push("asset_not_listed");
  const want = new Map<string, number>();
  for (const r of requested) want.set(r.sku, (want.get(r.sku) ?? 0) + r.qty);
  const got = new Map<string, number>();
  let sum = 0n;
  for (const line of order.lines) {
    got.set(line.sku, (got.get(line.sku) ?? 0) + line.qty);
    const item = listing.items.find((i) => i.sku === line.sku);
    if (!item) {
      issues.push(`item_not_listed:${line.sku}`);
      continue;
    }
    if (line.unitPrice !== item.unitPrice) issues.push(`price_mismatch:${line.sku}`);
    if (line.category !== item.category) issues.push(`category_mismatch:${line.sku}`);
    if (!/^\d+$/.test(line.unitPrice) || !Number.isInteger(line.qty) || line.qty < 1) issues.push(`line_malformed:${line.sku}`);
    else sum += BigInt(line.unitPrice) * BigInt(line.qty);
  }
  const sameItems = want.size === got.size && [...want].every(([sku, q]) => got.get(sku) === q);
  if (!sameItems) issues.push("order_lines_mismatch");
  if (order.total !== sum.toString()) issues.push("total_mismatch");
  const categories = [...new Set(order.lines.map((l) => l.category))].sort();
  if (JSON.stringify([...order.categories].sort()) !== JSON.stringify(categories)) issues.push("categories_mismatch");
  return issues;
}
