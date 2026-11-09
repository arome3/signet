import { AccountAddress, TransactionEventTag, TransactionHash, TransactionKindString, TransactionStatusEnum, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import type { ChainReader } from "../core/types.js";
import type { LiveConfig } from "./config.js";

/**
 * Reads finalized transactions over gRPC for receipt verification: RegisterData payloads (Signet
 * anchors) and PLT TokenTransfer events (x402 payments). Anything not finalized, not of the expected
 * kind, or not understood by this SDK version reads as "not found", so receipt checks fail closed.
 *
 * Status: written against @concordium/web-sdk 12 types; not yet run against testnet.
 */
export class ConcordiumChainReader implements ChainReader {
  readonly network: string;
  constructor(cfg: LiveConfig, private readonly grpc: ConcordiumGRPCClient) {
    this.network = cfg.caip2;
  }

  private async finalizedSummary(txHash: string): Promise<Record<string, any> | undefined> {
    try {
      const st = await this.grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash));
      if (st.status !== TransactionStatusEnum.Finalized) return undefined;
      return (st.outcome?.summary ?? undefined) as Record<string, any> | undefined;
    } catch {
      return undefined;
    }
  }

  async registeredData(txHash: string) {
    const s = await this.finalizedSummary(txHash);
    if (s?.transactionType !== TransactionKindString.RegisterData || !s.sender || typeof s.dataRegistered?.data !== "string") return undefined;
    return { sender: AccountAddress.toBase58(s.sender), data: new Uint8Array(Buffer.from(s.dataRegistered.data, "hex")) };
  }

  async transfers(txHash: string) {
    const s = await this.finalizedSummary(txHash);
    if (s?.transactionType !== TransactionKindString.TokenUpdate || !Array.isArray(s.events)) return undefined;
    const out: { from: string; to: string; asset: string; amount: string }[] = [];
    for (const ev of s.events) {
      if (!ev || ev.tag !== TransactionEventTag.TokenTransfer || !ev.from?.address || !ev.to?.address) continue;
      out.push({ from: AccountAddress.toBase58(ev.from.address), to: AccountAddress.toBase58(ev.to.address), asset: String(ev.tokenId?.value ?? ev.tokenId), amount: String(ev.amount?.value) });
    }
    return out;
  }
}
