import type { Order } from "./protocol.js";
import { type AccountSignature, signAs, verifySigned } from "./signing.js";
import type { AccountProver, AccountVerifier, AgentRegistry, DomainVerifier } from "./types.js";

/**
 * Verified-merchant directory (the spec's hackathon shortcut: a static list signed by the directory
 * operator). Each listing is signed by the merchant's badge account and binds together:
 *   badge  <->  brand (one per business; ASCII, one script)  <->  domain (DNS TXT proof; ASCII)
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
  /** The operator's explicit exceptions to the ASCII / single-script rule. */
  allowlist: ScriptAllowlist;
  listings: SignedListing[];
}

export interface SignedDirectory {
  directory: Directory;
  operatorSignature: AccountSignature;
}

export async function signListing(listing: Listing, merchant: AccountProver): Promise<SignedListing> {
  return { listing, merchantSignature: await signAs(merchant, "signet-listing", listing) };
}

/**
 * Brands and domains must be plain ASCII and use one script. Anything else (Cyrillic or Greek letters
 * that look Latin, fullwidth letters, accents, invisible characters, punycode `xn--` domains) is refused
 * unless the operator allowlists that exact string; the allowlist is part of the signed directory.
 */
export interface ScriptAllowlist {
  brands?: string[];
  domains?: string[];
}

const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Georgian", "Hebrew", "Arabic", "Devanagari", "Thai", "Hangul", "Hiragana", "Katakana", "Han"].map(
  (name) => [name, new RegExp(`\\p{Script=${name}}`, "u")] as const,
);

/** Scripts of the letters in `text` (digits, spaces and punctuation are script-neutral). */
export function scriptsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    out.add(SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? "Other");
  }
  return out;
}

export function brandTextIssues(brand: string, allow: ScriptAllowlist = {}): string[] {
  if ((allow.brands ?? []).some((b) => b.normalize("NFC") === brand.normalize("NFC"))) return [];
  const issues: string[] = [];
  if (scriptsOf(brand).size > 1) issues.push("brand_mixed_script");
  if (/[^\x20-\x7E]/.test(brand)) issues.push("brand_non_ascii");
  return issues;
}

export function domainTextIssues(domain: string, allow: ScriptAllowlist = {}): string[] {
  if ((allow.domains ?? []).some((d) => d.toLowerCase() === domain.toLowerCase())) return [];
  const issues: string[] = [];
  if (scriptsOf(domain).size > 1) issues.push("domain_mixed_script");
  if (/[^\x21-\x7E]/.test(domain) || /(^|\.)xn--/i.test(domain)) issues.push("domain_non_ascii");
  return issues;
}

/** Comparison key for brands: case, spacing and punctuation ignored. */
export function brandKey(brand: string): string {
  return brand.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
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
  /** Operator side: exceptions to the script rule (written into the signed directory). */
  scriptAllowlist?: ScriptAllowlist;
}

/** Checks one listing on its own: merchant signature, verified business badge, domain and endpoint. */
async function checkListing(sl: SignedListing, deps: ListingDeps, allow: ScriptAllowlist): Promise<string[]> {
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
  issues.push(...brandTextIssues(l.brand, allow), ...domainTextIssues(l.domain, allow));
  return issues;
}

/**
 * Operator side: vets listings and signs the ones that pass. A brand belongs to the first business
 * owner that lists it; a later listing with the same brand (ignoring case, spacing and punctuation)
 * from another owner is refused, each business owner gets one brand, and brands and domains must pass
 * the ASCII / single-script rule unless allowlisted.
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
    const reasons = await checkListing(sl, deps, deps.scriptAllowlist ?? {});
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
  const allowlist: ScriptAllowlist = { brands: deps.scriptAllowlist?.brands ?? [], domains: deps.scriptAllowlist?.domains ?? [] };
  const directory: Directory = { v: 1, operator: operator.account, issuedAt: new Date().toISOString(), allowlist, listings: accepted };
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
  const issues = await checkListing(sl, deps, dir.directory.allowlist ?? {});
  const key = brandKey(l.brand);
  if (dir.directory.listings.some((x) => x !== sl && brandKey(x.listing.brand) === key)) issues.push("brand_conflict");
  if (answered.name !== l.brand) issues.push("brand_mismatch");
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
