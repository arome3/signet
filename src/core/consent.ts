import { createInterface } from "node:readline/promises";
import { sha256Hex } from "./canonical.js";
import { formatAmount } from "./mandate.js";
import { signAs, verifySigned } from "./signing.js";
import type { AccountProver, AccountVerifier, ConsentProvider, ConsentRequest, ConsentResult } from "./types.js";

/** The exact sentence the owner approves. Its hash is what the audit trail commits to. */
export function consentText(r: ConsentRequest, decimals = 6): string {
  const who = r.merchantName ? `${r.merchantName} (${r.merchantBadge})` : r.merchantBadge;
  return (
    `I approve my agent ${r.agent} paying ${formatAmount(r.amount, decimals, r.asset)} to ${who} ` +
    `for order ${r.orderId}: ${r.summary}. Reason asked: ${r.reasons.join(", ")}.`
  );
}

/** What the owner signs when approving: binds the approval to one order, amount and merchant. */
export function approvalPayload(a: { agent: string; orderHash: string; merchant: string; amount: bigint | string; asset: string; textHash: string }) {
  return { agent: a.agent, orderHash: a.orderHash, merchant: a.merchant, amount: a.amount.toString(), asset: a.asset, textHash: a.textHash };
}

async function signedResult(r: ConsentRequest, approved: boolean, method: ConsentResult["method"], owner?: AccountProver): Promise<ConsentResult> {
  const textHash = sha256Hex(consentText(r));
  if (!approved || !owner) return { approved, method, textHash };
  if (owner.account !== r.owner) throw new Error("consent signer is not the mandate owner");
  const ownerSignature = await signAs(owner, "signet-approval", approvalPayload({ ...r, merchant: r.merchantBadge, textHash }));
  return { approved, method, textHash, ownerSignature };
}

/**
 * Simulated owner (tests, offline demo). Pass the owner's prover so approvals are signed and a
 * merchant can verify them; without it, approvals are unsigned and merchants will refuse them.
 */
export class AutoConsent implements ConsentProvider {
  constructor(
    private readonly approve: boolean | ((r: ConsentRequest) => boolean) = true,
    private readonly owner?: AccountProver,
  ) {}
  async request(r: ConsentRequest): Promise<ConsentResult> {
    const approved = typeof this.approve === "function" ? this.approve(r) : this.approve;
    return signedResult(r, approved, "auto", this.owner);
  }
}

/** The owner at the terminal. With the owner's key loaded, a "y" is signed so merchants can check it. */
export class TerminalConsent implements ConsentProvider {
  constructor(private readonly owner?: AccountProver) {}
  async request(r: ConsentRequest): Promise<ConsentResult> {
    const text = consentText(r);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\n[owner consent] ${text}\nApprove? (y/N) `);
    rl.close();
    return signedResult(r, /^y(es)?$/i.test(answer.trim()), "terminal", this.owner);
  }
}

/** Merchant side: is this a verifiable owner approval of exactly this order? */
export async function checkApproval(
  c: ConsentResult | undefined,
  expected: { owner: string; agent: string; orderHash: string; merchant: string; amount: string; asset: string },
  verifier: AccountVerifier,
): Promise<string[]> {
  if (!c) return ["approval_required"];
  if (c.approved !== true) return ["approval_not_given"];
  if (!c.ownerSignature) return ["approval_unverifiable"];
  const ok = await verifySigned(verifier, c.ownerSignature, "signet-approval", approvalPayload({ ...expected, textHash: c.textHash }), [expected.owner]);
  return ok ? [] : ["approval_bad_signature"];
}
