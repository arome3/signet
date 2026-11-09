import { AuditLedger } from "./core/ledger.js";
import { loadSignedMandate } from "./core/mandate-file.js";
import { TerminalConsent } from "./core/consent.js";
import type { ConsentProvider } from "./core/types.js";
import { SignetBuyer } from "./buyer/agent.js";
import { createMerchantApp, type CatalogItem } from "./seller/merchant.js";
import { ConcordiumAccountProver, ConcordiumAccountVerifier } from "./concordium/account.js";
import { ConcordiumAnchorSink } from "./concordium/anchor.js";
import { ConcordiumChainReader } from "./concordium/chain.js";
import { DnsDomainVerifier } from "./concordium/domain.js";
import type { SignedDirectory } from "./core/directory.js";
import { readFileSync } from "node:fs";
import { grpcClient, loadConfig, loadWalletExport } from "./concordium/config.js";
import { ConcordiumAttributeVerifier, createAgeRequest } from "./concordium/identity.js";
import { ConcordiumRail } from "./concordium/rail.js";
import { ConcordiumRegistry } from "./concordium/registry.js";

/**
 * Wires Signet to Concordium testnet from environment variables (see .env.example).
 * Every adapter here is the real one: hosted Agent Registry MCP + gRPC for badges and identity
 * providers, @x402/concordium for sponsored PLT payments, RegisterData for anchors.
 */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

/** Signed directory written by `npm run directory:build`; refuses to start without one (fail closed). */
function loadDirectory() {
  const path = process.env.DIRECTORY_FILE ?? "out/directory.json";
  let listings: SignedDirectory;
  try {
    listings = JSON.parse(readFileSync(path, "utf8")) as SignedDirectory;
  } catch (e) {
    throw new Error(`cannot read merchant directory ${path} (${(e as Error).message}); run \`npm run directory:build\``);
  }
  return { listings, operator: need("DIRECTORY_OPERATOR"), domains: new DnsDomainVerifier(), allowLoopbackEndpoints: process.env.SIGNET_ALLOW_LOOPBACK_ENDPOINTS === "1" };
}

export function liveBuyer(opts: { consent?: ConsentProvider; ledgerFile?: string } = {}) {
  const cfg = loadConfig();
  const grpc = grpcClient(cfg);
  const agent = loadWalletExport(need("AGENT_WALLET_FILE"));
  const sponsor = process.env.ANCHOR_SPONSOR_WALLET_FILE ? loadWalletExport(process.env.ANCHOR_SPONSOR_WALLET_FILE) : undefined;
  const badge = need("AGENT_BADGE");
  // Signed by the owner with `npm run mandate:sign`; its hash must be the badge's `signet.mandate` metadata.
  const mandate = loadSignedMandate(process.env.SIGNED_MANDATE_FILE ?? "out/mandate.signed.json", badge);
  // Optional: the owner's key, so a "y" at the terminal is a signed approval merchants can verify.
  // Without it, orders that need approval are refused by merchants (fail closed) until ID App approval lands.
  const owner = process.env.OWNER_WALLET_FILE ? loadWalletExport(process.env.OWNER_WALLET_FILE) : undefined;
  const ledger = new AuditLedger(opts.ledgerFile ?? process.env.AGENT_LEDGER_FILE ?? "out/agent-ledger.jsonl");
  const buyer = new SignetBuyer({
    badge,
    mandate,
    prover: new ConcordiumAccountProver(agent),
    // Live age proofs need the agent's identity commitment input (Agent IDP). Until then, merchants
    // that sell age-restricted goods will refuse, which is the safe default.
    rail: new ConcordiumRail(cfg, { payer: agent }),
    registry: new ConcordiumRegistry(cfg, grpc),
    verifier: new ConcordiumAccountVerifier(grpc),
    consent: opts.consent ?? new TerminalConsent(owner ? new ConcordiumAccountProver(owner) : undefined),
    ledger,
    directory: loadDirectory(),
  });
  return { cfg, grpc, buyer, ledger, badge, anchorSink: new ConcordiumAnchorSink(cfg, grpc, agent, sponsor), chain: new ConcordiumChainReader(cfg, grpc), registry: new ConcordiumRegistry(cfg, grpc), verifier: new ConcordiumAccountVerifier(grpc) };
}

export function liveMerchant(catalog: CatalogItem[], opts: { ledgerFile?: string } = {}) {
  const cfg = loadConfig();
  const grpc = grpcClient(cfg);
  const merchant = loadWalletExport(need("MERCHANT_WALLET_FILE"));
  const facilitator = process.env.FACILITATOR_WALLET_FILE ? loadWalletExport(process.env.FACILITATOR_WALLET_FILE) : merchant;
  const badge = need("MERCHANT_BADGE");
  const ledger = new AuditLedger(opts.ledgerFile ?? process.env.MERCHANT_LEDGER_FILE ?? "out/merchant-ledger.jsonl");
  const issuers = (process.env.AGE_PROOF_IDPS ?? "0,1,2,3").split(",").map(Number);
  const app = createMerchantApp({
    name: process.env.MERCHANT_NAME ?? "FreshMart",
    domain: process.env.MERCHANT_DOMAIN,
    badge,
    payTo: merchant.address,
    asset: cfg.asset,
    catalog,
    prover: new ConcordiumAccountProver(merchant),
    rail: new ConcordiumRail(cfg, { facilitator }),
    registry: new ConcordiumRegistry(cfg, grpc),
    verifier: new ConcordiumAccountVerifier(grpc),
    attributes: new ConcordiumAttributeVerifier(cfg, grpc, merchant),
    makeAgeRequest: (threshold) => createAgeRequest(cfg, grpc, merchant, threshold, process.env.MERCHANT_DOMAIN ?? "freshmart.example", issuers),
    ledger,
  });
  return { cfg, app, ledger, badge, anchorSink: new ConcordiumAnchorSink(cfg, grpc, merchant) };
}
