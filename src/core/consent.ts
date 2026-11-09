import { createInterface } from "node:readline/promises";
import { sha256Hex } from "./canonical.js";
import { formatAmount } from "./mandate.js";
import type { ConsentProvider, ConsentRequest, ConsentResult } from "./types.js";

/** The exact sentence the owner approves. Its hash is what the audit trail commits to. */
export function consentText(r: ConsentRequest, decimals = 6): string {
  const who = r.merchantName ? `${r.merchantName} (${r.merchantBadge})` : r.merchantBadge;
  return (
    `I approve my agent ${r.agent} paying ${formatAmount(r.amount, decimals, r.asset)} to ${who} ` +
    `for order ${r.orderId}: ${r.summary}. Reason asked: ${r.reasons.join(", ")}.`
  );
}

export class AutoConsent implements ConsentProvider {
  constructor(private readonly approve: boolean | ((r: ConsentRequest) => boolean) = true) {}
  async request(r: ConsentRequest): Promise<ConsentResult> {
    const approved = typeof this.approve === "function" ? this.approve(r) : this.approve;
    return { approved, method: "auto", textHash: sha256Hex(consentText(r)) };
  }
}

export class TerminalConsent implements ConsentProvider {
  async request(r: ConsentRequest): Promise<ConsentResult> {
    const text = consentText(r);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\n[owner consent] ${text}\nApprove? (y/N) `);
    rl.close();
    return { approved: /^y(es)?$/i.test(answer.trim()), method: "terminal", textHash: sha256Hex(text) };
  }
}
