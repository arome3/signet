import { decodeAnchor } from "./anchor.js";
import { hashOf, verifyMerkleProof } from "./canonical.js";
import { type AuditLedger, entryHashValid } from "./ledger.js";
import type { Receipt, ReceiptBody, ReceiptProof } from "./protocol.js";
import { signAs, verifySigned } from "./signing.js";
import type { AccountProver, AccountVerifier, AgentRegistry, ChainReader } from "./types.js";

export async function signReceipt(body: ReceiptBody, merchant: AccountProver): Promise<Receipt> {
  return { ...body, merchantSignature: await signAs(merchant, "signet-receipt", body) };
}

export function receiptBody(r: Receipt): ReceiptBody {
  const { merchantSignature: _sig, ...body } = r;
  return body;
}

/**
 * Builds the proof for a receipt from the merchant's ledger. Undefined until the `delivery` entry
 * that commits to the receipt has been anchored.
 */
export function buildReceiptProof(ledger: AuditLedger, receipt: Receipt): ReceiptProof | undefined {
  const rh = hashOf(receipt);
  const entry = ledger.all.find((e) => e.type === "delivery" && e.orderId === receipt.orderId && e.data.receiptHash === rh);
  if (!entry) return undefined;
  const inclusion = ledger.inclusionProof(entry.seq);
  if (!inclusion) return undefined;
  return { v: 1, receipt, entry, ...inclusion };
}

export type ReceiptCheck =
  | "receipt_signature"
  | "entry_hash"
  | "entry_commits_to_receipt"
  | "merkle_inclusion"
  | "anchor_on_chain"
  | "payment_on_chain"
  | "payer_bound_to_buyer";

export interface ReceiptVerification {
  ok: boolean;
  checks: Record<ReceiptCheck, { ok: boolean; detail?: string }>;
  /** Failed check names with detail, e.g. "anchor_on_chain:anchor_sender_not_merchant". */
  issues: string[];
}

/**
 * Checks every part of a receipt against the registry and the chain, trusting neither party:
 *   1. the merchant's badge account signed the receipt;
 *   2. the log entry's hash recomputes and it commits to exactly this receipt;
 *   3. the Merkle path leads from that entry, at its position, to the anchored root;
 *   4. a finalized RegisterData transaction from the merchant's account carries that root;
 *   5. a finalized transfer moved the stated amount from the payer to the merchant's account;
 *   6. the payer is the buyer badge's account.
 * Every check runs; any check that cannot run (unknown tx, lookup error) fails. `ok` only if all pass.
 */
export async function verifyReceipt(
  proof: ReceiptProof,
  deps: { registry: AgentRegistry; verifier: AccountVerifier; chain: ChainReader },
): Promise<ReceiptVerification> {
  const checks = {} as ReceiptVerification["checks"];
  const run = async (name: ReceiptCheck, fn: () => Promise<string | undefined> | string | undefined) => {
    try {
      const failure = await fn();
      checks[name] = failure ? { ok: false, detail: failure } : { ok: true };
    } catch (e) {
      checks[name] = { ok: false, detail: `check_error:${(e as Error).message}`.slice(0, 160) };
    }
  };
  const r = proof?.receipt;
  const e = proof?.entry;
  const a = proof?.anchor;
  if (!r || !e || !a) {
    const all: ReceiptCheck[] = ["receipt_signature", "entry_hash", "entry_commits_to_receipt", "merkle_inclusion", "anchor_on_chain", "payment_on_chain", "payer_bound_to_buyer"];
    for (const c of all) checks[c] = { ok: false, detail: "proof_malformed" };
    return { ok: false, checks, issues: all.map((c) => `${c}:proof_malformed`) };
  }

  const merchant = await deps.registry.check(r.merchant).catch(() => undefined);
  const merchantAccounts = [merchant?.owner, merchant?.agentWallet].filter((x): x is string => !!x);

  await run("receipt_signature", async () => {
    if (!merchantAccounts.length) return "merchant_badge_unknown";
    return (await verifySigned(deps.verifier, r.merchantSignature, "signet-receipt", receiptBody(r), merchantAccounts)) ? undefined : "bad_merchant_signature";
  });

  await run("entry_hash", () => (entryHashValid(e) ? undefined : "entry_hash_mismatch"));

  await run("entry_commits_to_receipt", () => {
    const rh = hashOf(r);
    if (e.type !== "delivery") return "entry_not_delivery";
    if (e.orderId !== r.orderId) return "entry_order_mismatch";
    if (e.actor !== r.merchant) return "entry_actor_not_merchant";
    if (e.data.receiptHash !== rh || e.dataHash !== rh) return "entry_receipt_hash_mismatch";
    return undefined;
  });

  await run("merkle_inclusion", () => {
    if (!(a.from <= e.seq && e.seq < a.to)) return "entry_outside_anchored_range";
    return verifyMerkleProof(e.hash, proof.path, a.root, e.seq - a.from, a.to - a.from) ? undefined : "path_does_not_reach_root";
  });

  await run("anchor_on_chain", async () => {
    if (a.network !== r.network || a.network !== deps.chain.network) return "network_mismatch";
    const tx = await deps.chain.registeredData(a.txHash);
    if (!tx) return "anchor_tx_not_found";
    if (!merchantAccounts.includes(tx.sender)) return "anchor_sender_not_merchant";
    const on = decodeAnchor(tx.data);
    if (on.root !== a.root || on.from !== a.from || on.to !== a.to) return "anchor_contents_mismatch";
    return undefined;
  });

  await run("payment_on_chain", async () => {
    if (r.network !== deps.chain.network) return "network_mismatch";
    if (!merchantAccounts.includes(r.payTo)) return "payto_not_merchant_account";
    const transfers = await deps.chain.transfers(r.txHash);
    if (!transfers) return "payment_tx_not_found";
    const hit = transfers.some((t) => t.from === r.payer && t.to === r.payTo && t.asset === r.asset && t.amount === r.paid);
    return hit ? undefined : "payment_does_not_match_receipt";
  });

  await run("payer_bound_to_buyer", async () => {
    const buyer = await deps.registry.check(r.buyer);
    return buyer.found && [buyer.owner, buyer.agentWallet].includes(r.payer) ? undefined : "payer_not_buyer_account";
  });

  const issues = Object.entries(checks)
    .filter(([, v]) => !v.ok)
    .map(([k, v]) => `${k}:${v.detail}`);
  return { ok: issues.length === 0, checks, issues };
}
