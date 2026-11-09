import { AccountAddress, signMessage, verifyMessageSignature, type AccountTransactionSignature } from "@concordium/web-sdk";
import type { ConcordiumGRPCClient } from "@concordium/web-sdk";
import type { AccountProver, AccountVerifier } from "../core/types.js";
import type { LoadedAccount } from "./config.js";

/** Signs Signet challenges with a Concordium account's keys (Concordium message-signing scheme). */
export class ConcordiumAccountProver implements AccountProver {
  constructor(private readonly acc: LoadedAccount) {}
  get account() {
    return this.acc.address;
  }
  async sign(message: string): Promise<AccountTransactionSignature> {
    return signMessage(this.acc.accountAddress, message, this.acc.signer);
  }
}

/** Verifies against the account's on-chain credentials and threshold. */
export class ConcordiumAccountVerifier implements AccountVerifier {
  constructor(private readonly grpc: ConcordiumGRPCClient) {}
  async verify(account: string, message: string, signature: unknown): Promise<boolean> {
    try {
      const info = await this.grpc.getAccountInfo(AccountAddress.fromBase58(account));
      return await verifyMessageSignature(message, signature as AccountTransactionSignature, info);
    } catch {
      return false;
    }
  }
}

/**
 * Smart-contract wire form of an account signature (concordium-std `AccountSignatures`): u8 count of
 * credentials, then per credential its u8 index, u8 count of keys, and per key its u8 index, the tag 0
 * (Ed25519) and the 64 signature bytes. Maps are written in ascending index order.
 */
export function serializeAccountSignature(sig: AccountTransactionSignature): string {
  const byIndex = <T>(m: Record<number, T>) => Object.entries(m).map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0]);
  const u8 = (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`index or count ${n} does not fit in a byte`);
    return n.toString(16).padStart(2, "0");
  };
  const creds = byIndex(sig);
  let out = u8(creds.length);
  for (const [ci, keys] of creds) {
    const ks = byIndex(keys);
    out += u8(ci) + u8(ks.length);
    for (const [ki, hex] of ks) {
      if (!/^[0-9a-f]{128}$/i.test(hex)) throw new Error("expected a 64-byte Ed25519 signature");
      out += u8(ki) + "00" + hex.toLowerCase();
    }
  }
  return out;
}
