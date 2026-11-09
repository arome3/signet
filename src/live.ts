import { AuditLedger } from "./core/ledger.js";
import { parseMandate, type Mandate } from "./core/mandate.js";
import { TerminalConsent } from "./core/consent.js";
import type { ConsentProvider } from "./core/types.js";
import { SignetBuyer } from "./buyer/agent.js";
import { createMerchantApp, type CatalogItem } from "./seller/merchant.js";
import { ConcordiumAccountProver, ConcordiumAccountVerifier } from "./concordium/account.js";
import { ConcordiumAnchorSink } from "./concordium/anchor.js";
import { grpcClient, loadConfig, loadWalletExport } from "./concordium/config.js";
import { ConcordiumAttributeVerifier, createAgeRequest } from "./concordium/identity.js";
import { ConcordiumRail } from "./concordium/rail.js";
import { ConcordiumRegistry } from "./concordium/registry.js";
import { readFileSync } from "node:fs";

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

export function liveBuyer(opts: { consent?: ConsentProvider; ledgerFile?: string } = {}) {
  const cfg = loadConfig();
  const grpc = grpcClient(cfg);
  const agent = loadWalletExport(need("AGENT_WALLET_FILE"));
  const sponsor = process.env.ANCHOR_SPONSOR_WALLET_FILE ? loadWalletExport(process.env.ANCHOR_SPONSOR_WALLET_FILE) : undefined;
  const badge = need("AGENT_BADGE");
  const mandate: Mandate = parseMandate({ ...JSON.parse(readFileSync(need("MANDATE_FILE"), "utf8")), agent: badge });
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
    consent: opts.consent ?? new TerminalConsent(),
    ledger,
  });
  return { cfg, grpc, buyer, ledger, badge, anchorSink: new ConcordiumAnchorSink(cfg, grpc, agent, sponsor) };
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
