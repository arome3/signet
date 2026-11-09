/**
 * Concordium testnet run: starts FreshMart with live adapters and has the agent buy groceries.
 *   cp .env.example .env   # fill in wallet exports, badges, asset
 *   npm run demo:live
 */
import { anchorPending } from "../src/core/anchor.js";
import { formatAmount } from "../src/core/mandate.js";
import { accountabilityReport } from "../src/core/report.js";
import { liveBuyer, liveMerchant } from "../src/live.js";
import { CATALOG } from "./scenario.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
mkdirSync("out", { recursive: true });

const port = Number(process.env.MERCHANT_PORT ?? 4021);
const shop = liveMerchant(CATALOG);
const server = shop.app.listen(port);
const url = process.env.MERCHANT_URL ?? `http://127.0.0.1:${port}`;
const kit = liveBuyer();

console.log(`Network ${kit.cfg.caip2}, asset ${kit.cfg.asset}`);
for (const [title, items] of [
  ["Groceries", [{ sku: "bread", qty: 1 }, { sku: "milk", qty: 1 }]],
  ["Champagne (needs owner consent)", [{ sku: "champagne", qty: 1 }]],
] as const) {
  const o = await kit.buyer.purchase(url, [...items]);
  if (o.status === "paid") console.log(`${title}: PAID ${formatAmount(o.receipt.paid, 6, o.receipt.asset)} ${o.receipt.explorer}`);
  else console.log(`${title}: REFUSED at ${o.stage}: ${o.reasons.join(", ")}`);
}
const a = await anchorPending(kit.ledger, kit.anchorSink, kit.badge);
const m = await anchorPending(shop.ledger, shop.anchorSink, shop.badge);
console.log(`Agent log anchored: ${a?.receipt.explorerUrl}\nMerchant log anchored: ${m?.receipt.explorerUrl}`);
writeFileSync("out/live-agent-accountability.md", accountabilityReport(kit.ledger, "Agent accountability record (testnet)"));
server.close();
process.exit(0);
