/**
 * Concordium testnet run: starts FreshMart with live adapters and has the agent buy groceries.
 *   cp .env.example .env   # fill in wallet exports, badges, asset; see `npm run testnet -- check`
 *   npm run demo:live
 * Prints a CCDExplorer link for every payment and log anchor, and verifies each receipt against the chain.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fetchReceiptProof } from "../src/buyer/agent.js";
import { anchorPending } from "../src/core/anchor.js";
import { formatAmount } from "../src/core/mandate.js";
import { verifyReceipt } from "../src/core/receipt.js";
import { accountabilityReport } from "../src/core/report.js";
import { liveBuyer, liveMerchant } from "../src/live.js";
import { CATALOG } from "./scenario.js";

if (existsSync(".env")) process.loadEnvFile(".env");
mkdirSync("out", { recursive: true });

const port = Number(process.env.MERCHANT_PORT ?? 4021);
const shop = liveMerchant(CATALOG);
const server = shop.app.listen(port, "127.0.0.1");
const url = process.env.MERCHANT_URL ?? `http://127.0.0.1:${port}`;
const kit = liveBuyer();
const links: string[] = [];

console.log(`Network ${kit.cfg.caip2}, asset ${kit.cfg.asset}, merchant ${url}`);
const paid: string[] = [];
for (const [title, items] of [
  ["Groceries (inside the mandate)", [{ sku: "bread", qty: 1 }, { sku: "milk", qty: 1 }]],
  ["Seven boxes of eggs (over the per-payment limit: the owner is asked)", [{ sku: "eggs", qty: 7 }]],
] as const) {
  const o = await kit.buyer.purchase(url, [...items]);
  if (o.status === "paid") {
    paid.push(o.receipt.orderId);
    links.push(`payment  ${title}: ${o.receipt.explorer}`);
    console.log(`${title}: PAID ${formatAmount(o.receipt.paid, 6, o.receipt.asset)} ${o.receipt.explorer}`);
  } else console.log(`${title}: REFUSED at ${o.stage}: ${o.reasons.join(", ")}`);
}

const a = await anchorPending(kit.ledger, kit.anchorSink, kit.badge);
const m = await anchorPending(shop.ledger, shop.anchorSink, shop.badge);
if (a) links.push(`anchor   agent log entries ${a.anchor.from}-${a.anchor.to - 1}: ${a.receipt.explorerUrl}`);
if (m) links.push(`anchor   merchant log entries ${m.anchor.from}-${m.anchor.to - 1}: ${m.receipt.explorerUrl}`);
console.log(`Agent log anchored: ${a?.receipt.explorerUrl ?? "nothing to anchor"}\nMerchant log anchored: ${m?.receipt.explorerUrl ?? "nothing to anchor"}`);

for (const id of paid) {
  const proof = await fetchReceiptProof(url, id);
  const v = proof ? await verifyReceipt(proof, { registry: kit.registry, verifier: kit.verifier, chain: kit.chain }) : undefined;
  console.log(`Receipt ${id}: ${v?.ok ? "VERIFIED on chain (signature, log entry, Merkle path, anchor, payment)" : `NOT verified: ${v?.issues.join(", ") ?? "no proof served"}`}`);
}

writeFileSync("out/live-agent-accountability.md", accountabilityReport(kit.ledger, "Agent accountability record (testnet)"));
writeFileSync("out/live-links.txt", links.join("\n") + "\n");
console.log(`\nCCDExplorer links (also in out/live-links.txt):\n${links.map((l) => "  " + l).join("\n")}`);
server.close();
process.exit(0);
