/**
 * Testnet setup helpers for the first live run. Prints addresses and transaction links only, never key
 * material. Reads .env; writes public setup state (addresses, URIs, hashes, badges, tx hashes) to
 * out/testnet/<role>.json.
 *
 *   npm run testnet -- check                       preflight: keys, accounts, balances, IdPs, badges, mandate, DNS, directory
 *   npm run testnet -- card agent <public-url>     build the agent's Agent Card -> out/testnet/agent-card.json (host it at <public-url>)
 *   npm run testnet -- card merchant <public-url>  same for the merchant
 *   npm run testnet -- register agent|merchant     verify the hosted card's hash, then mint the CIS-8004 badge (signed with that role's key)
 *   npm run testnet -- publish-mandate             set the agent badge's `signet.mandate` metadata to the signed mandate's hash
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AccountAddress, CcdAmount, ContractAddress, Energy, Parameter, ReceiveName, TransactionExpiry, TransactionHash } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { explorerTx, grpcClient, loadConfig, loadWalletExport, type LoadedAccount } from "../src/concordium/config.js";
import { DnsDomainVerifier } from "../src/concordium/domain.js";
import { ConcordiumRegistry, registryTool } from "../src/concordium/registry.js";
import { mandateHash } from "../src/core/mandate.js";
import { loadSignedMandate } from "../src/core/mandate-file.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const cfg = loadConfig();
const grpc = grpcClient(cfg);
const OUT = "out/testnet";
mkdirSync(OUT, { recursive: true });

type Role = "agent" | "merchant";
const KEYS: Record<Role | "owner", string> = {
  owner: process.env.OWNER_WALLET_FILE ?? "keys/owner.export",
  agent: process.env.AGENT_WALLET_FILE ?? "keys/agent.export",
  merchant: process.env.MERCHANT_WALLET_FILE ?? "keys/merchant.export",
};
const accountLink = (a: string) => `https://ccdexplorer.io/${cfg.network}/account/${a}`;
const state = (r: Role): Record<string, any> => (existsSync(`${OUT}/${r}.json`) ? JSON.parse(readFileSync(`${OUT}/${r}.json`, "utf8")) : {});
const save = (r: Role, s: Record<string, unknown>) => writeFileSync(`${OUT}/${r}.json`, JSON.stringify(s, null, 2) + "\n");
const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await registryTool(cfg.registryMcpUrl, name, { network: cfg.network, ...args });
  if (r.error) throw new Error(`${name}: ${r.error}`);
  return r.data as any;
};
const role = (x?: string): Role => (x === "agent" || x === "merchant" ? x : (console.error("role must be agent or merchant"), process.exit(2)));

/** Signs and submits a contract update built by the registry MCP server; waits for finalization. */
async function sendUpdate(acc: LoadedAccount, built: any): Promise<string> {
  const payload = {
    amount: CcdAmount.zero(),
    address: ContractAddress.create(built.contract_address.index, built.contract_address.subindex),
    receiveName: ReceiveName.fromString(built.receive_name),
    message: Parameter.fromHexString(built.parameter_hex),
  };
  const { nonce } = await grpc.getNextAccountNonce(acc.accountAddress);
  const tx = Transaction.updateContract(payload, Energy.create(BigInt(built.suggested_energy ?? 30000)))
    .addMetadata({ sender: acc.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) })
    .build();
  const hash = await grpc.sendTransaction(Transaction.finalize(await Transaction.sign(tx, acc.signer)));
  const hex = TransactionHash.toHexString(hash);
  console.log(`  submitted ${built.receive_name}: ${explorerTx(cfg, hex)}`);
  const outcome = (await grpc.waitForTransactionFinalization(hash, 120_000)) as any;
  const summary = outcome?.summary;
  if (summary?.transactionType === "failed" || summary?.rejectReason) throw new Error(`transaction rejected: ${JSON.stringify(summary.rejectReason ?? summary).slice(0, 300)}`);
  return hex;
}

async function card(r: Role, uri?: string) {
  if (!uri || !/^https:\/\//.test(uri)) throw new Error("give the public https URL where you will host the card");
  const acc = loadWalletExport(KEYS[r]);
  const isAgent = r === "agent";
  const built = await mcp("build_agent_card", {
    name: isAgent ? "Kit (Signet shopping agent)" : (process.env.MERCHANT_NAME ?? "FreshMart"),
    description: isAgent
      ? "Shopping agent that pays only verified merchants, inside its owner's signed Signet mandate."
      : "Grocery merchant agent: quotes over x402, checks buyer badges, mandates and age, settles on Concordium.",
    agent_uri: uri,
    owner_account: acc.address,
    skills: isAgent
      ? [{ id: "shop", name: "Shop within a mandate", description: "Buys from verified merchants within its owner's limits", tags: ["signet", "x402"] }]
      : [{ id: "sell", name: "Sell groceries over x402", description: "Quotes and settles orders for verified agents", tags: ["signet", "x402"] }],
  });
  const json: string = built.agent_card_json;
  const sha = createHash("sha256").update(json).digest("hex");
  if (sha !== built.metadata_hash_hex) throw new Error("registry hash does not match the card bytes; not writing");
  writeFileSync(`${OUT}/${r}-card.json`, json);
  save(r, { ...state(r), account: acc.address, agentUri: uri, metadataHash: sha, cardFile: `${OUT}/${r}-card.json` });
  console.log(`Wrote ${OUT}/${r}-card.json (sha256 ${sha}).\nHost it byte-for-byte at ${uri}, then run: npm run testnet -- register ${r}`);
}

async function register(r: Role) {
  const s = state(r);
  if (!s.agentUri) throw new Error(`run: npm run testnet -- card ${r} <url> first`);
  if (s.badge) return console.log(`${r} already registered: badge ${s.badge} (${s.registerTx})`);
  const acc = loadWalletExport(KEYS[r]);
  const res = await fetch(s.agentUri, { signal: AbortSignal.timeout(15000) });
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(body).digest("hex");
  if (res.status !== 200 || got !== s.metadataHash) throw new Error(`hosted card at ${s.agentUri} is HTTP ${res.status}, sha256 ${got}; expected ${s.metadataHash}. Host ${s.cardFile} byte-for-byte.`);
  console.log(`Card at ${s.agentUri} matches. Registering ${r} from ${acc.address} ...`);
  const built = await mcp("build_register", { agent_uri: s.agentUri, metadata_hash_hex: s.metadataHash, sender: acc.address });
  const tx = await sendUpdate(acc, built);
  let agent: any;
  for (let i = 0; i < 20 && !agent; i++) {
    const list = await mcp("agents_by_owner", { owner_account: acc.address, limit: 100 }).catch(() => undefined);
    agent = (list?.agents ?? []).filter((a: any) => a.agent_uri === s.agentUri && a.metadata_hash_hex === s.metadataHash).sort((a: any, b: any) => Number(b.token_id) - Number(a.token_id))[0];
    if (!agent) await new Promise((res) => setTimeout(res, 3000));
  }
  if (!agent) throw new Error(`registered (tx ${tx}) but the indexer has not listed it yet; rerun 'check' in a minute`);
  const ta = await mcp("token_address", { contract_index: built.contract_address.index, contract_subindex: built.contract_address.subindex, token_id: String(agent.token_id) });
  save(r, { ...s, tokenId: String(agent.token_id), badge: ta.token_address, registerTx: tx });
  console.log(`${r} badge: ${ta.token_address} (token ${agent.token_id})\nSet ${r === "agent" ? "AGENT_BADGE" : "MERCHANT_BADGE"}=${ta.token_address} in .env`);
}

async function publishMandate() {
  const s = state("agent");
  if (!s.badge) throw new Error("register the agent first");
  const signed = loadSignedMandate(process.env.SIGNED_MANDATE_FILE ?? "out/mandate.signed.json", s.badge);
  const hash = mandateHash(signed.mandate);
  const acc = loadWalletExport(KEYS.agent);
  const built = await mcp("build_set_metadata", { token_id: s.tokenId, key: "signet.mandate", value_hex: Buffer.from(hash, "utf8").toString("hex"), sender: acc.address });
  const tx = await sendUpdate(acc, built);
  const v = await new ConcordiumRegistry(cfg, grpc, 0).check(s.badge);
  save("agent", { ...s, mandateHash: hash, mandateTx: tx });
  if (v.mandateHash !== hash) throw new Error(`published (tx ${tx}) but the registry reads back ${v.mandateHash ?? "nothing"} for signet.mandate`);
  console.log(`signet.mandate = ${hash} on ${s.badge}, read back OK.`);
}

async function check() {
  const ok = (b: boolean) => (b ? "ok  " : "FAIL");
  const status = await grpc.getConsensusStatus().then(() => true).catch(() => false);
  console.log(`${ok(status)} gRPC ${cfg.grpcHost}:${cfg.grpcPort} (${cfg.network})`);
  const caps = await registryTool(cfg.registryMcpUrl, "agent_registry_capabilities", { network: cfg.network });
  console.log(`${ok(!caps.error)} Agent Registry MCP ${cfg.registryMcpUrl}${caps.error ? `: ${caps.error}` : ""}`);
  const registry = new ConcordiumRegistry(cfg, grpc, 0);
  const accounts: Partial<Record<Role | "owner", LoadedAccount>> = {};
  for (const r of ["owner", "agent", "merchant"] as const) {
    if (!existsSync(KEYS[r])) {
      console.log(`FAIL ${r}: no key file at ${KEYS[r]}`);
      continue;
    }
    try {
      const acc = loadWalletExport(KEYS[r]);
      accounts[r] = acc;
      const info = await grpc.getAccountInfo(AccountAddress.fromBase58(acc.address)).catch(() => undefined);
      if (!info) {
        console.log(`FAIL ${r}: ${acc.address} not found on ${cfg.network}`);
        continue;
      }
      const ccd = Number((info as any).accountAmount?.microCcdAmount ?? 0n) / 1e6;
      const ip = await registry.identityProviderOf(acc.address);
      const tokens = ((info as any).accountTokens ?? []).map((t: any) => `${t.id?.value ?? t.id} ${t.state?.balance?.value ?? t.state?.balance ?? "?"}`).join(", ");
      console.log(`ok   ${r}: ${acc.address}  ${ccd} CCD${tokens ? `, tokens: ${tokens}` : ""}  IdP ${ip}  ${accountLink(acc.address)}`);
    } catch (e) {
      console.log(`FAIL ${r}: cannot read ${KEYS[r]} (${(e as Error).message.slice(0, 80)})`);
    }
  }
  for (const [r, envName] of [["agent", "AGENT_BADGE"], ["merchant", "MERCHANT_BADGE"]] as const) {
    const badge = process.env[envName] || state(r).badge;
    if (!badge) {
      console.log(`--   ${r} badge: not registered yet`);
      continue;
    }
    const v = await registry.check(badge);
    const owns = accounts[r] && [v.owner, v.agentWallet].includes(accounts[r]!.address);
    console.log(`${ok(v.verified && !!owns)} ${r} badge ${badge}: verified=${v.verified} ownerKind=${v.ownerKind} key-account-bound=${!!owns}${v.issues.length ? ` issues=${v.issues.join(",")}` : ""}`);
    if (r === "agent") {
      const file = process.env.SIGNED_MANDATE_FILE ?? "out/mandate.signed.json";
      const want = existsSync(file) ? mandateHash(JSON.parse(readFileSync(file, "utf8")).mandate) : undefined;
      console.log(`${ok(!!want && v.mandateHash === want)} signet.mandate: published=${v.mandateHash ?? "none"} signed=${want ?? "no signed mandate yet"}`);
    }
    if (r === "merchant") console.log(`${ok(v.ownerKind === "business")} merchant owner is a business identity (required by the directory and the mandate)`);
  }
  const domain = process.env.MERCHANT_DOMAIN;
  if (domain && accounts.merchant) {
    const dns = await new DnsDomainVerifier().verify(domain, accounts.merchant.address);
    console.log(`${ok(dns)} DNS TXT _signet.${domain} = "signet-account=${accounts.merchant.address}"`);
  } else console.log(`--   DNS: set MERCHANT_DOMAIN and add the merchant key first`);
  const dir = process.env.DIRECTORY_FILE ?? "out/directory.json";
  console.log(`${existsSync(dir) ? "ok  " : "--  "} directory ${dir}${existsSync(dir) ? "" : " (run npm run directory:build)"}`);
  console.log(`${process.env.SIGNET_ALLOW_LOOPBACK_ENDPOINTS === "1" ? "ok  " : "--  "} local mode (SIGNET_ALLOW_LOOPBACK_ENDPOINTS=1), asset ${cfg.asset}`);
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === "check") await check();
  else if (cmd === "card") await card(role(a), b);
  else if (cmd === "register") await register(role(a));
  else if (cmd === "publish-mandate") await publishMandate();
  else console.log("usage: npm run testnet -- check | card <agent|merchant> <url> | register <agent|merchant> | publish-mandate");
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
process.exit(0);
