import { canonicalJson } from "./canonical.js";
import type { AccountProver, AccountVerifier } from "./types.js";

/**
 * Purpose-tagged account signatures. Every Signet statement an account signs (mandate, spend
 * statement, approval, receipt, listing) is wrapped as `{ purpose, v, payload }` before signing, so a
 * signature made for one purpose can never be replayed as another.
 */
export interface AccountSignature {
  /** Concordium account that signed. */
  account: string;
  /** Mock: hex ed25519. Live: Concordium AccountTransactionSignature JSON. */
  sig: unknown;
}

export type SigningPurpose = "signet-mandate" | "signet-spend" | "signet-approval" | "signet-receipt" | "signet-listing" | "signet-directory";

export function signingMessage(purpose: SigningPurpose, payload: unknown): string {
  return canonicalJson({ purpose, v: 1, payload });
}

export async function signAs(prover: AccountProver, purpose: SigningPurpose, payload: unknown): Promise<AccountSignature> {
  return { account: prover.account, sig: await prover.sign(signingMessage(purpose, payload)) };
}

/**
 * True only if `s` is a valid signature over `payload` for `purpose` by `s.account`, and (when
 * given) `s.account` is one of `allowed`. Any error counts as invalid (fail closed).
 */
export async function verifySigned(
  verifier: AccountVerifier,
  s: AccountSignature | undefined,
  purpose: SigningPurpose,
  payload: unknown,
  allowed?: (string | undefined)[],
): Promise<boolean> {
  if (!s || typeof s.account !== "string" || s.sig === undefined) return false;
  if (allowed && !allowed.filter(Boolean).includes(s.account)) return false;
  try {
    return await verifier.verify(s.account, signingMessage(purpose, payload), s.sig);
  } catch {
    return false;
  }
}
