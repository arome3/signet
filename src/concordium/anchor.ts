import { AccountAddress, DataBlob, TransactionExpiry, TransactionHash, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import type { AnchorReceipt, AnchorSink } from "../core/anchor.js";
import { explorerTx, type LiveConfig, type LoadedAccount } from "./config.js";

/**
 * Registers Signet anchors with a `RegisterData` transaction. If a sponsor account is given,
 * the transaction is built as a V1 sponsored transaction (sender signs, sponsor co-signs and pays),
 * so an agent account can anchor its log without holding CCD.
 */
export class ConcordiumAnchorSink implements AnchorSink {
  readonly network: string;
  constructor(
    private readonly cfg: LiveConfig,
    private readonly grpc: ConcordiumGRPCClient,
    private readonly sender: LoadedAccount,
    private readonly sponsor?: LoadedAccount,
  ) {
    this.network = cfg.caip2;
  }

  async register(data: Uint8Array): Promise<AnchorReceipt> {
    const { nonce } = await this.grpc.getNextAccountNonce(this.sender.accountAddress);
    const metadata = { sender: this.sender.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) };
    const builder = Transaction.registerData({ data: new DataBlob(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) }).addMetadata(metadata);
    let signable;
    if (this.sponsor) {
      signable = builder.addSponsor(AccountAddress.fromBase58(this.sponsor.address)).build();
      signable = await Transaction.sign(signable, this.sender.signer);
      signable = await Transaction.sponsor(signable as never, this.sponsor.signer);
    } else {
      signable = await Transaction.sign(builder.build(), this.sender.signer);
    }
    const hash = await this.grpc.sendTransaction(Transaction.finalize(signable));
    await this.grpc.waitForTransactionFinalization(hash, 60_000);
    const hex = TransactionHash.toHexString(hash);
    return { txHash: hex, network: this.network, explorerUrl: explorerTx(this.cfg, hex) };
  }
}
