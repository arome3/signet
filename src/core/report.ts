import type { AuditLedger, LedgerEntry } from "./ledger.js";
import { formatAmount } from "./mandate.js";

/**
 * Human-readable accountability record for one agent, structured around EU AI Act Art. 12(2):
 * events that identify risk situations, support post-market monitoring, and let the deployer
 * (the owner) monitor operation. The report contains no personal data; the accountable person is
 * reachable only through Concordium's lawful-disclosure process (court order, 2-of-3 privacy guardians).
 */
export function accountabilityReport(ledger: AuditLedger, title: string, decimals = 6): string {
  const v = ledger.verify();
  const rows = ledger.all.map((e) => `| ${e.seq} | ${e.ts.slice(11, 19)} | ${e.type} | ${e.orderId ?? ""} | ${describe(e, decimals)} | \`${e.hash.slice(0, 12)}\` |`);
  const anchors = ledger.all.filter((e) => e.type === "anchor");
  const risk = ledger.all.filter((e) => (e.type === "mandate_check" && e.data.decision !== "allow") || e.type === "payment_rejected" || (e.type === "counterparty_check" && !e.data.ok));
  return [
    `# ${title}`,
    "",
    `Chain integrity: **${v.ok ? "verified" : `BROKEN at entry ${v.brokenAt}`}** (${ledger.all.length} entries, head \`${ledger.head.slice(0, 16)}\`)`,
    "",
    `On-chain anchors: ${anchors.length ? anchors.map((a) => `entries ${a.data.from}-${Number(a.data.to) - 1} -> \`${String(a.data.txHash).slice(0, 16)}\` (${a.data.explorer ?? a.data.network})`).join("; ") : "none yet"}`,
    "",
    `## Situations that needed a human or were refused (Art. 12(2)(a))`,
    "",
    ...(risk.length ? risk.map((e) => `- #${e.seq} ${e.type}: ${describe(e, decimals)}`) : ["- none"]),
    "",
    `## Full event log (Art. 12(2)(b)-(c))`,
    "",
    "| # | time (UTC) | event | order | detail | hash |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function describe(e: LedgerEntry, decimals: number): string {
  const d = e.data as Record<string, any>;
  const amt = (x: unknown, a: unknown) => formatAmount(String(x ?? 0), decimals, String(a ?? ""));
  switch (e.type) {
    case "mandate_published":
      return `mandate ${String(d.mandate).slice(0, 12)} per-payment ${amt(d.perPaymentLimit, d.asset)} daily ${amt(d.dailyLimit, d.asset)}`;
    case "request":
      return `order ${amt(d.total, d.asset)} [${(d.categories ?? []).join(", ")}]${d.buyer ? ` from ${d.buyer}` : ""}`;
    case "counterparty_check":
      return `${d.badge} ${d.ok ? "verified" : "REJECTED"} (${d.ownerKind})${d.issues?.length ? ": " + d.issues.join(", ") : ""}`;
    case "mandate_check":
      return `${d.decision.toUpperCase()}: ${d.reasons.join(", ")}`;
    case "consent_requested":
      return `asked owner: ${d.reasons.join(", ")}`;
    case "consent_result":
      return `owner ${d.approved ? "APPROVED" : "DECLINED"} via ${d.method}`;
    case "payment_signed":
      return `signed ${amt(d.amount, d.asset)} (sponsored, no CCD needed)`;
    case "payment_verified":
      return `buyer ${d.buyer} proved badge${d.ageOver ? `, age >= ${d.ageOver} proven (ZK)` : ""}`;
    case "payment_settled":
      return `settled ${amt(d.amount, d.asset)} tx \`${String(d.txHash).slice(0, 12)}\``;
    case "payment_rejected":
      return `rejected: ${(d.reasons ?? []).join(", ")}`;
    case "delivery":
      return `receipt ${String(d.receiptHash).slice(0, 12)}`;
    case "anchor":
      return `anchored ${d.from}-${Number(d.to) - 1} root ${String(d.root).slice(0, 12)}`;
    default:
      return JSON.stringify(d);
  }
}
