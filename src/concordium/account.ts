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
