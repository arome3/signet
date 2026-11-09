/**
 * Signet as an MCP server: give any MCP-capable agent (Claude, Cursor, LangGraph, OpenAI Agents)
 * a wallet that only pays verified counterparties, inside its owner's mandate, with an audit trail.
 *
 *   SIGNET_MODE=mock (default): starts a local FreshMart on the mock chain, so it works offline.
 *   SIGNET_MODE=live          : Concordium testnet, configured from .env.
 *
 * Claude Desktop config:
 *   { "mcpServers": { "signet": { "command": "npx", "args": ["tsx", "/path/to/signet/src/mcp/server.ts"] } } }
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { anchorPending, type AnchorSink } from "../core/anchor.js";
import type { AuditLedger } from "../core/ledger.js";
import { formatAmount } from "../core/mandate.js";
import { accountabilityReport } from "../core/report.js";
import type { SignetBuyer } from "../buyer/agent.js";

const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
const mode = process.env.SIGNET_MODE ?? "mock";

let buyer: SignetBuyer;
let ledger: AuditLedger;
let sink: AnchorSink;
let badge: string;
let defaultMerchant: string | undefined;

if (mode === "live") {
  const { liveBuyer } = await import("../live.js");
  const b = liveBuyer();
  ({ buyer, ledger, badge } = b);
  sink = b.anchorSink;
  defaultMerchant = process.env.MERCHANT_URL;
} else {
  const { buildMockScenario } = await import("../../demo/scenario.js");
  // In mock mode consent is simulated: approve up to 100 USDR. Live mode asks the real owner.
  const s = await buildMockScenario({ approve: (r) => r.amount <= 100_000_000n });
  buyer = s.kit;
  ledger = s.kitLedger;
  badge = s.kitBadge;
  sink = s.world.anchorSink(s.kitAccount.address);
  defaultMerchant = s.shopUrl;
}

const server = new McpServer({ name: "signet", version: "0.1.0" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

server.registerTool(
  "signet_buy",
  {
    description:
      "Buy items from a merchant agent. Signet verifies the merchant's Verified-by-Concordium badge, checks the owner's mandate, asks the owner for consent when needed, proves this agent's badge (and owner age if required) and pays in a stablecoin with sponsored fees. Returns the receipt or the reason it refused.",
    inputSchema: {
      items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1),
      merchant_url: z.string().url().optional().describe("Merchant base URL; defaults to the configured merchant"),
    },
  },
  async ({ items, merchant_url }) => {
    const url = merchant_url ?? defaultMerchant;
    if (!url) return text("No merchant_url given and none configured.");
    const o = await buyer.purchase(url, items);
    if (o.status === "paid") {
      return text(`Paid ${formatAmount(o.receipt.paid, 6, o.receipt.asset)} for order ${o.receipt.orderId}. tx ${o.receipt.txHash}${o.receipt.explorer ? ` (${o.receipt.explorer})` : ""}. Mandate: ${o.evaluation.reasons.join(", ")}${o.consent ? `; owner consent ${o.consent.approved ? "given" : "refused"} via ${o.consent.method}` : ""}.`);
    }
    return text(`Refused at ${o.stage}: ${o.reasons.join(", ")}.`);
  },
);

server.registerTool("signet_catalog", { description: "List what the merchant sells (from /.well-known/signet).", inputSchema: { merchant_url: z.string().url().optional() } }, async ({ merchant_url }) => {
  const url = merchant_url ?? defaultMerchant;
  if (!url) return text("No merchant configured.");
  const r = await fetch(new URL("/.well-known/signet", url));
  return text(JSON.stringify(await r.json(), null, 2));
});

server.registerTool("signet_status", { description: "This agent's badge, mandate hash and spend so far today.", inputSchema: {} }, async () =>
  text(`Agent ${badge}\nMandate ${buyer.mandateHash}\nSpent today ${formatAmount(buyer.spentToday(), 6, "USDR")}`),
);

server.registerTool("signet_audit", { description: "Verify the hash chain and return the accountability record (EU AI Act Art. 12 style).", inputSchema: {} }, async () =>
  text(accountabilityReport(ledger, `Accountability record for ${badge}`)),
);

server.registerTool("signet_anchor", { description: "Commit all unanchored log entries to Concordium (RegisterData) and return the transaction.", inputSchema: {} }, async () => {
  const a = await anchorPending(ledger, sink, badge);
  return text(a ? `Anchored entries ${a.anchor.from}-${a.anchor.to - 1}, root ${a.anchor.root}, tx ${a.receipt.txHash} ${a.receipt.explorerUrl ?? ""}` : "Nothing new to anchor.");
});

await server.connect(new StdioServerTransport());
