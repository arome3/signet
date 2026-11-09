/**
 * Builds the signed merchant directory for a testnet run.
 *   1. The merchant signs its listing (brand, domain, endpoint, catalog prices) with MERCHANT_WALLET_FILE.
 *   2. The directory operator (DIRECTORY_OPERATOR_WALLET_FILE) vets it against the live registry and DNS
 *      and signs the directory. Writes DIRECTORY_FILE (default out/directory.json); no key material.
 * Needs: MERCHANT_BADGE, MERCHANT_NAME, MERCHANT_DOMAIN with a TXT record
 *   _signet.<MERCHANT_DOMAIN>  "signet-account=<merchant account>"
 * and MERCHANT_URL (https on that domain; SIGNET_ALLOW_LOOPBACK_ENDPOINTS=1 accepts http://127.0.0.1 for local runs).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConcordiumAccountProver, ConcordiumAccountVerifier } from "../src/concordium/account.js";
import { grpcClient, loadConfig, loadWalletExport } from "../src/concordium/config.js";
import { DnsDomainVerifier } from "../src/concordium/domain.js";
import { ConcordiumRegistry } from "../src/concordium/registry.js";
import { buildDirectory, signListing } from "../src/core/directory.js";
import { catalogListing } from "../src/seller/merchant.js";
import { CATALOG } from "../demo/scenario.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const need = (n: string): string => process.env[n] || (console.error(`missing env ${n} (see .env.example)`), process.exit(1));

const cfg = loadConfig();
const grpc = grpcClient(cfg);
const merchant = loadWalletExport(need("MERCHANT_WALLET_FILE"));
const operator = loadWalletExport(need("DIRECTORY_OPERATOR_WALLET_FILE"));
const listing = catalogListing(
  { badge: need("MERCHANT_BADGE"), name: need("MERCHANT_NAME"), domain: need("MERCHANT_DOMAIN"), asset: cfg.asset, catalog: CATALOG },
  need("MERCHANT_URL"),
);
const { directory, refused } = await buildDirectory([await signListing(listing, new ConcordiumAccountProver(merchant))], new ConcordiumAccountProver(operator), {
  registry: new ConcordiumRegistry(cfg, grpc),
  verifier: new ConcordiumAccountVerifier(grpc),
  domains: new DnsDomainVerifier(),
  allowLoopbackEndpoints: process.env.SIGNET_ALLOW_LOOPBACK_ENDPOINTS === "1",
});
for (const r of refused) console.error(`REFUSED ${r.brand} (${r.badge}): ${r.reasons.join(", ")}`);
const out = process.env.DIRECTORY_FILE ?? "out/directory.json";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(directory, null, 2) + "\n");
console.log(`${directory.directory.listings.length} listing(s) signed by ${operator.address} -> ${out}`);
console.log(`Set DIRECTORY_OPERATOR=${operator.address} for the buyer.`);
process.exit(refused.length ? 1 : 0);
