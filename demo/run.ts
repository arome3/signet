import { mkdirSync, writeFileSync } from "node:fs";
import { anchorPending } from "../src/core/anchor.js";
import { formatAmount } from "../src/core/mandate.js";
import { accountabilityReport } from "../src/core/report.js";
import { buildMockScenario, STEPS } from "./scenario.js";

const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };
const say = (s = "") => console.log(s);

say(`${c.bold}Signet demo: a shopping agent that can prove who answers for it${c.reset}`);
say(`${c.dim}Mode: offline mock of Concordium (registry, identity, PLT, sponsored tx, RegisterData).${c.reset}\n`);

const s = await buildMockScenario();
say(`Owner Ada (human identity)     ${c.dim}${s.ada.address}${c.reset}`);
say(`Agent "Kit" badge              ${s.kitBadge}  ${c.dim}(agent-IDP account, owner revealed only date of birth)${c.reset}`);
say(`Merchant FreshMart badge       ${s.shopBadge}  ${c.dim}(business identity)${c.reset}`);
say(`Mandate ${c.dim}${s.kit.mandateHash.slice(0, 16)}${c.reset}: up to 20 USDR per payment, 50 USDR per day, never tobacco, verified businesses only\n`);

let pass = 0;
for (const [i, step] of STEPS.entries()) {
  const o: any = await step.run(s);
  const got = o.status === "http" ? (o.code === 403 ? "http403" : `http${o.code}`) : o.status;
  const ok = got === step.expect;
  pass += ok ? 1 : 0;
  say(`${c.bold}${i + 1}. ${step.title}${c.reset}`);
  if (o.status === "paid") {
    const consent = o.consent ? `${c.yellow}owner consent: approved${c.reset}  ` : "";
    say(`   ${c.green}PAID${c.reset} ${formatAmount(o.receipt.paid, 6, o.receipt.asset)}  ${consent}${c.dim}tx ${o.receipt.txHash.slice(0, 16)}  mandate: ${o.evaluation.reasons.join(", ")}${c.reset}`);
  } else if (o.status === "denied") {
    say(`   ${c.red}REFUSED${c.reset} at ${o.stage}: ${o.reasons.join(", ")}`);
  } else {
    say(`   ${c.red}HTTP ${o.code}${c.reset} before any quote: ${o.body.reasons.join(", ")}`);
  }
  say(`   ${ok ? c.green + "as expected" : c.red + "UNEXPECTED, wanted " + step.expect}${c.reset}\n`);
}

const kitAnchor = await anchorPending(s.kitLedger, s.world.anchorSink(s.kitAccount.address), s.kitBadge);
const shopAnchor = await anchorPending(s.merchantLedger, s.world.anchorSink(s.shop.address), s.shopBadge);
say(`${c.bold}Accountability${c.reset}`);
say(`   Kit ledger:       ${s.kitLedger.all.length} entries, chain ${s.kitLedger.verify().ok ? "verified" : "BROKEN"}, anchored root ${kitAnchor?.anchor.root.slice(0, 16)} in tx ${kitAnchor?.receipt.txHash.slice(0, 16)}`);
say(`   FreshMart ledger: ${s.merchantLedger.all.length} entries, chain ${s.merchantLedger.verify().ok ? "verified" : "BROKEN"}, anchored root ${shopAnchor?.anchor.root.slice(0, 16)} in tx ${shopAnchor?.receipt.txHash.slice(0, 16)}`);
say(`   Kit spent today:  ${formatAmount(s.kit.spentToday(), 6, "USDR")} of 150 USDR balance`);

mkdirSync("out", { recursive: true });
writeFileSync("out/kit-accountability.md", accountabilityReport(s.kitLedger, "Kit (shopping agent): accountability record"));
writeFileSync("out/freshmart-accountability.md", accountabilityReport(s.merchantLedger, "FreshMart (merchant agent): accountability record"));
say(`   Reports written to out/kit-accountability.md and out/freshmart-accountability.md`);
say(`\n${pass}/${STEPS.length} scenarios behaved as expected.`);
s.close();
process.exit(pass === STEPS.length ? 0 : 1);
