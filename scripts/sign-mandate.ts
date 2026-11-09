/**
 * Owner step: sign the agent's mandate with the owner's Concordium account.
 *   MANDATE_FILE=./mandate.example.json OWNER_WALLET_FILE=./keys/owner.export AGENT_BADGE=... npm run mandate:sign
 * Writes the signed mandate (no key material) to SIGNED_MANDATE_FILE (default out/mandate.signed.json)
 * and prints the hash to publish as the badge's `signet.mandate` metadata in the Agent Registry.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConcordiumAccountProver } from "../src/concordium/account.js";
import { loadWalletExport } from "../src/concordium/config.js";
import { mandateHash, parseMandate, signMandate } from "../src/core/mandate.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const need = (n: string) => process.env[n] || (console.error(`missing env ${n} (see .env.example)`), process.exit(1));

const owner = loadWalletExport(need("OWNER_WALLET_FILE"));
const draft = JSON.parse(readFileSync(need("MANDATE_FILE"), "utf8"));
if (!draft.owner || /^YOUR_/.test(draft.owner)) draft.owner = owner.address;
// The mandate's asset must be the asset payments are made in (e.g. CCD for a first run without a stablecoin).
const mandate = parseMandate({ ...draft, asset: process.env.SIGNET_ASSET || draft.asset, agent: need("AGENT_BADGE") });
if (mandate.owner !== owner.address) {
  console.error(`mandate names owner ${mandate.owner} but OWNER_WALLET_FILE is ${owner.address}`);
  process.exit(1);
}
const signed = await signMandate(mandate, new ConcordiumAccountProver(owner));
const out = process.env.SIGNED_MANDATE_FILE ?? "out/mandate.signed.json";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(signed, null, 2) + "\n");
console.log(`Signed mandate for agent ${mandate.agent} by owner ${mandate.owner} -> ${out}`);
console.log(`Publish this as the badge's signet.mandate metadata:\n${mandateHash(mandate)}`);
