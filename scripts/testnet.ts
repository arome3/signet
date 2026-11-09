/**
 * Testnet setup helpers for the first live run. Prints addresses and transaction links only, never key
 * material. Reads .env; writes public setup state (addresses, URIs, hashes, badges, tx hashes) to
 * out/testnet/<role>.json.
 *
 *   npm run testnet -- check                       preflight: keys, accounts, balances, IdPs, badges, mandate, DNS, directory
 *   npm run testnet -- card agent <public-url>     build the agent's Agent Card -> out/testnet/agent-card.json (host it at <public-url>)
 *   npm run testnet -- card merchant <public-url>  same for the merchant
 *   npm run testnet -- register agent|merchant     verify the hosted card's hash, then mint the CIS-8004 badge
 *   npm run testnet -- wallet agent                set the agent's account as the badge's agentWallet (agent signs, owner sends)
 *   npm run testnet -- card agent                  after registering: rebuild the card with its tokenAddress (host it at the same URL)
 *   npm run testnet -- pin agent|merchant          verify the re-hosted card, then pin its hash on-chain with setAgentURI
 *   npm run testnet -- publish-mandate             set the agent badge's `signet.mandate` metadata to the signed mandate's hash
 *
 * Who controls each badge: the OWNER registers the agent's badge and is its CIS-2 owner, so only the owner
 * can change `signet.mandate` (merchants require the mandate's owner to be the badge owner); the agent's
 * account is only the badge's agentWallet and pays. The merchant registers and owns its own badge.
 * Every transaction is dry-run with invokeInstance first and is not sent if the contract would reject it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AccountAddress, CcdAmount, ContractAddress, Energy, Parameter, ReceiveName, signMessage, TransactionExpiry, TransactionHash } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { serializeAccountSignature } from "../src/concordium/account.js";
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
/** The account that registers and owns each badge (see the header). */
const CONTROLLER: Record<Role, "owner" | "merchant"> = { agent: "owner", merchant: "merchant" };
const controller = (r: Role) => loadWalletExport(KEYS[CONTROLLER[r]]);
const accountLink = (a: string) => `https://ccdexplorer.io/${cfg.network}/account/${a}`;
const state = (r: Role): Record<string, any> => (existsSync(`${OUT}/${r}.json`) ? JSON.parse(readFileSync(`${OUT}/${r}.json`, "utf8")) : {});
const save = (r: Role, s: Record<string, unknown>) => writeFileSync(`${OUT}/${r}.json`, JSON.stringify(s, null, 2) + "\n");
const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await registryTool(cfg.registryMcpUrl, name, { network: cfg.network, ...args });
  if (r.error) throw new Error(`${name}: ${r.error}`);
  return r.data as any;
};
const role = (x?: string): Role => (x === "agent" || x === "merchant" ? x : (console.error("role must be agent or merchant"), process.exit(2)));

const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** Runs a contract update built by the registry MCP server as `sender` without sending it (free). */
async function dryRun(sender: string, built: any): Promise<{ ok: boolean; reason?: string }> {
  const r = await grpc.invokeContract({
    invoker: AccountAddress.fromBase58(sender),
    contract: ContractAddress.create(built.contract_address.index, built.contract_address.subindex),
    method: ReceiveName.fromString(built.receive_name),
    parameter: Parameter.fromHexString(built.parameter_hex),
    energy: Energy.create(BigInt(built.suggested_energy ?? 30000) * 2n),
  });
  return r.tag === "success" ? { ok: true } : { ok: false, reason: json(r.reason).slice(0, 200) };
}

/** Dry-runs, then signs and submits a contract update built by the registry MCP server; waits for finalization. */
async function sendUpdate(acc: LoadedAccount, built: any): Promise<string> {
  const d = await dryRun(acc.address, built);
  if (!d.ok) throw new Error(`dry run of ${built.receive_name} as ${acc.address} was rejected, nothing sent: ${d.reason}`);
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

async function card(r: Role, uriArg?: string) {
  const prev = state(r);
  // Before minting the card has no tokenAddress; after minting, rebuild it with the token id so the badge's
  // Concordium extension block is complete, and pin the new hash with `pin`.
  const uri = uriArg ?? prev.agentUri;
  if (!uri || !/^https:\/\//.test(uri)) throw new Error("give the public https URL where you will host the card");
  const acc = controller(r);
  const isAgent = r === "agent";
  const built = await mcp("build_agent_card", {
    name: isAgent ? "Kit (Signet shopping agent)" : (process.env.MERCHANT_NAME ?? "FreshMart"),
    description: isAgent
      ? "Shopping agent that pays only verified merchants, inside its owner's signed Signet mandate."
      : "Grocery merchant agent: quotes over x402, checks buyer badges, mandates and age, settles on Concordium.",
    agent_uri: uri,
    owner_account: acc.address,
    ...(prev.tokenId !== undefined ? { token_id: String(prev.tokenId) } : {}),
    skills: isAgent
      ? [{ id: "shop", name: "Shop within a mandate", description: "Buys from verified merchants within its owner's limits", tags: ["signet", "x402"] }]
      : [{ id: "sell", name: "Sell groceries over x402", description: "Quotes and settles orders for verified agents", tags: ["signet", "x402"] }],
  });
  const json: string = built.agent_card_json;
  const sha = createHash("sha256").update(json).digest("hex");
  if (sha !== built.metadata_hash_hex) throw new Error("registry hash does not match the card bytes; not writing");
  writeFileSync(`${OUT}/${r}-card.json`, json);
  save(r, { ...prev, account: acc.address, agentUri: uri, metadataHash: sha, cardFile: `${OUT}/${r}-card.json`, pinned: prev.tokenId === undefined ? undefined : false });
  const next = prev.tokenId === undefined ? `npm run testnet -- register ${r}` : `npm run testnet -- pin ${r}`;
  console.log(`Wrote ${OUT}/${r}-card.json (sha256 ${sha}${prev.tokenId !== undefined ? `, includes token ${prev.tokenId}` : ""}).\nHost it byte-for-byte at ${uri}, then run: ${next}`);
}

/** Fetches the hosted card and requires its exact bytes to hash to `expected`. */
async function hostedCardMatches(uri: string, expected: string, file: string) {
  const res = await fetch(uri, { signal: AbortSignal.timeout(15000), cache: "no-store" });
  const got = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
  if (res.status !== 200 || got !== expected) throw new Error(`hosted card at ${uri} is HTTP ${res.status}, sha256 ${got}; expected ${expected}. Host ${file} byte-for-byte (caches can take a few minutes).`);
}

async function pin(r: Role) {
  const s = state(r);
  if (s.tokenId === undefined) throw new Error(`register ${r} first`);
  if (s.pinned !== false) throw new Error(`nothing new to pin; run: npm run testnet -- card ${r}`);
  await hostedCardMatches(s.agentUri, s.metadataHash, s.cardFile);
  const acc = controller(r);
  const built = await mcp("build_set_agent_uri", { token_id: String(s.tokenId), agent_uri: s.agentUri, metadata_hash_hex: s.metadataHash, sender: acc.address });
  const tx = await sendUpdate(acc, built);
  const v = await mcp("verify_agent_card", { token_id: String(s.tokenId) });
  save(r, { ...s, pinned: true, pinTx: tx });
  if (v?.match !== true) throw new Error(`pinned (tx ${tx}) but verify_agent_card reports match=${v?.match}`);
  console.log(`${r} card pinned and verified (match=true).`);
}

async function register(r: Role) {
  const s = state(r);
  if (!s.agentUri) throw new Error(`run: npm run testnet -- card ${r} <url> first`);
  if (s.badge) return console.log(`${r} already registered: badge ${s.badge} (${s.registerTx})`);
  const acc = controller(r);
  await hostedCardMatches(s.agentUri, s.metadataHash, s.cardFile);
  console.log(`Card at ${s.agentUri} matches. Registering the ${r} badge from the ${CONTROLLER[r]} account ${acc.address} ...`);
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
  console.log(`${r} badge: ${ta.token_address} (token ${agent.token_id}), owned by ${acc.address}\nSet ${r === "agent" ? "AGENT_BADGE" : "MERCHANT_BADGE"}=${ta.token_address} in .env`);
  if (r === "agent") console.log("Next: npm run testnet -- wallet agent");
}

const walletOf = (d: any): string | undefined => (typeof d === "string" ? d : (d?.agent_wallet ?? d?.wallet ?? d?.address ?? undefined)) || undefined;

/**
 * Sets the agent's account as the badge's agentWallet. CIS-8004 needs two authorisations: the agent's account
 * signs the contract's canonical message (proving it agrees to be the wallet) and the owner sends the
 * transaction. The deployed contract's message layout comes from the registry server; the signature encoding
 * is chosen by dry-running each candidate, and only one the contract accepts is sent.
 */
async function setWallet() {
  const s = state("agent");
  if (s.tokenId === undefined) throw new Error("register agent first");
  const owner = controller("agent");
  const agent = loadWalletExport(KEYS.agent);
  const token_id = String(s.tokenId);
  if (walletOf(await mcp("get_agent_wallet", { token_id })) === agent.address) {
    save("agent", { ...s, agentWallet: agent.address });
    return console.log(`agentWallet is already ${agent.address}`);
  }
  const deadline_unix_ms = Date.now() + 10 * 60_000;
  const cb = await mcp("set_agent_wallet_canonical_bytes", { token_id, new_wallet: agent.address, deadline_unix_ms });
  const bytes = Buffer.from(String(cb.bytes_hex ?? ""), "hex");
  if (!bytes.length || bytes.length !== cb.byte_length) throw new Error(`canonical message is ${bytes.length} bytes, server says ${cb.byte_length}`);
  if (!bytes.subarray(0, 26).equals(Buffer.from("CIS-8004/v1/setAgentWallet"))) throw new Error("canonical message does not start with the CIS-8004 setAgentWallet tag; not signing it");
  const viaWallet = await signMessage(agent.accountAddress, bytes, agent.signer);
  const raw = await agent.signer.sign(new Uint8Array(bytes).buffer);
  const candidates: [string, string][] = [
    ["account message signature (as the wallet's signMessage)", viaWallet[0][0]],
    ["account message signature, serialized AccountSignatures", serializeAccountSignature(viaWallet)],
    ["ed25519 over the bytes", raw[0][0]],
    ["ed25519 over the bytes, serialized AccountSignatures", serializeAccountSignature(raw)],
  ];
  for (const [label, signature_hex] of candidates) {
    const built = await mcp("build_set_agent_wallet", { token_id, new_wallet: agent.address, deadline_unix_ms, signature_hex, sender: owner.address });
    const d = await dryRun(owner.address, built);
    if (!d.ok) {
      console.log(`  dry run rejected (${label}): ${d.reason}`);
      continue;
    }
    console.log(`  dry run accepted: ${label}`);
    const tx = await sendUpdate(owner, built);
    const now = walletOf(await mcp("get_agent_wallet", { token_id }));
    save("agent", { ...s, agentWallet: agent.address, walletTx: tx, walletSignature: label });
    if (now !== agent.address) throw new Error(`setAgentWallet sent (tx ${tx}) but the registry reads back ${now ?? "nothing"}`);
    return console.log(`agentWallet = ${agent.address} on ${s.badge}, read back OK.`);
  }
  throw new Error("the contract rejected every signature encoding in a dry run; nothing was sent");
}

async function publishMandate() {
  const s = state("agent");
  if (!s.badge) throw new Error("register the agent first");
  const signed = loadSignedMandate(process.env.SIGNED_MANDATE_FILE ?? "out/mandate.signed.json", s.badge);
  const hash = mandateHash(signed.mandate);
  const acc = controller("agent");
  if (signed.mandate.owner !== acc.address) throw new Error(`the mandate names owner ${signed.mandate.owner}, but the badge owner key is ${acc.address}; merchants would refuse it`);
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
      // Every role sends transactions (owner: register/wallet/mandate; agent: payments, anchors; merchant: register, anchors).
      console.log(`${ok(ccd > 0)} ${r}: ${acc.address}  ${ccd} CCD${ccd > 0 ? "" : " (needs CCD for fees: wallet testnet faucet)"}${tokens ? `, tokens: ${tokens}` : ""}  IdP ${ip}  ${accountLink(acc.address)}`);
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
    const ctrl = accounts[CONTROLLER[r]];
    console.log(`${ok(v.verified)} ${r} badge ${badge}: verified=${v.verified} ownerKind=${v.ownerKind}${v.issues.length ? ` issues=${v.issues.join(",")}` : ""}`);
    console.log(`${ok(!!ctrl && v.owner === ctrl.address)} ${r} badge owner is the ${CONTROLLER[r]} account (${v.owner ?? "none"})`);
    if (r === "agent") {
      console.log(`${ok(!!accounts.agent && v.agentWallet === accounts.agent.address)} agentWallet is the agent account (${v.agentWallet ?? "not set: npm run testnet -- wallet agent"})`);
      const tokenId = state("agent").tokenId;
      if (tokenId !== undefined && accounts.agent && ctrl) {
        // Free dry run of the attack this design prevents: the agent rewriting its own mandate.
        const probe = await mcp("build_set_metadata", { token_id: String(tokenId), key: "signet.mandate", value_hex: "00", sender: accounts.agent.address });
        const [asAgent, asOwner] = [await dryRun(accounts.agent.address, probe), await dryRun(ctrl.address, probe)];
        console.log(`${ok(!asAgent.ok && asOwner.ok)} only the owner can change signet.mandate (dry run: agent ${asAgent.ok ? "ACCEPTED" : "rejected"}, owner ${asOwner.ok ? "accepted" : `rejected: ${asOwner.reason}`})`);
      }
    }
    // Concordium's own badge verdict: top-level badge_valid, a checks map and an issues list.
    const cb = await registryTool(cfg.registryMcpUrl, "check_badge", { id: badge, network: cfg.network });
    const d = (cb.data ?? {}) as Record<string, any>;
    const failing = Object.entries(d.checks ?? {}).filter(([, v]) => v === false).map(([k]) => k);
    const issues = (Array.isArray(d.issues) ? d.issues : []).map((i: any) => i?.message ?? String(i)).slice(0, 3);
    const valid = d.badge_valid === true;
    console.log(`${ok(valid)} ${r} check_badge: ${cb.error ? cb.error.slice(0, 120) : `badge_valid=${d.badge_valid}${failing.length ? ` failing=${failing.join(",")}` : ""}${issues.length ? ` issues=${issues.join(" | ")}` : ""}`}${valid ? "" : `  (after registering: npm run testnet -- card ${r}, host it, npm run testnet -- pin ${r})`}`);
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
  else if (cmd === "pin") await pin(role(a));
  else if (cmd === "wallet") await (role(a) === "agent" ? setWallet() : Promise.reject(new Error("only the agent's badge needs an agentWallet")));
  else if (cmd === "publish-mandate") await publishMandate();
  else console.log("usage: npm run testnet -- check | card <agent|merchant> [url] | register <agent|merchant> | wallet agent | pin <agent|merchant> | publish-mandate");
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
process.exit(0);
