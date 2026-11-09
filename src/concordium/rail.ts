import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { toConcordiumFacilitatorSigner } from "@x402/concordium";
import { ExactConcordiumScheme as ClientScheme } from "@x402/concordium/exact/client";
import { ExactConcordiumScheme as FacilitatorScheme } from "@x402/concordium/exact/facilitator";
import { AccountAddress, Cbor, CborAccountAddress, CborMemo, CcdAmount, DataBlob, TokenAmount, TokenId, TokenOperationType } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { decodeMemo, encodeMemo } from "../core/memo.js";
import type { PaymentRail } from "../core/types.js";
import { explorerTx, type LiveConfig, type LoadedAccount } from "./config.js";

/**
 * x402 "exact" payments on Concordium using the official @x402/concordium package:
 * the buyer sender-signs a V1 sponsored PLT transfer naming the facilitator as sponsor; the
 * facilitator checks the 9 safety rules, adds its sponsor signature, submits and waits for
 * finality. Buyers therefore never hold CCD; the merchant (or its facilitator) pays the ~€0.01 fee.
 */
export class ConcordiumRail implements PaymentRail {
  readonly network: string;
  private client?: ClientScheme;
  private readonly grpc: { grpcUrl: string; useTls: boolean };
  private readonly payer?: LoadedAccount;
  private facilitator?: FacilitatorScheme;

  constructor(
    private readonly cfg: LiveConfig,
    opts: { payer?: LoadedAccount; facilitator?: LoadedAccount },
  ) {
    this.network = cfg.caip2;
    this.grpc = { grpcUrl: `${cfg.grpcHost}:${cfg.grpcPort}`, useTls: true };
    this.payer = opts.payer;
    if (opts.payer) this.client = new ClientScheme({ accountAddress: opts.payer.accountAddress, signer: opts.payer.signer }, this.grpc);
    if (opts.facilitator) {
      this.feePayer = opts.facilitator.address;
      const signer = toConcordiumFacilitatorSigner(opts.facilitator.address, opts.facilitator.privateKeyHex, { host: cfg.grpcHost, port: cfg.grpcPort, useTls: true });
      this.facilitator = new FacilitatorScheme({ signer, requireFinalization: true });
    }
  }

  private feePayer?: string;

  async requirements({ payTo, asset, amount, memo, maxTimeoutSeconds = 120 }: { payTo: string; asset: string; amount: bigint; memo?: string; maxTimeoutSeconds?: number }): Promise<PaymentRequirements> {
    if (!this.feePayer) throw new Error("seller rail needs a facilitator account");
    if (memo !== undefined) encodeMemo(memo); // throws if over the chain's memo limit
    const extra = memo === undefined ? { feePayer: this.feePayer } : { feePayer: this.feePayer, memo };
    return { scheme: "exact", network: this.network as PaymentRequirements["network"], asset, amount: amount.toString(), payTo, maxTimeoutSeconds, extra };
  }

  async createPayment(req: PaymentRequirements): Promise<PaymentPayload> {
    if (!this.client || !this.payer) throw new Error("buyer rail needs a payer account");
    const memo = req.extra?.memo;
    if (memo === undefined) {
      const r = await this.client.createPaymentPayload(2, req);
      return { ...r, accepted: req } as PaymentPayload;
    }
    if (typeof memo !== "string") throw new Error("requirements.extra.memo must be a string");
    const r = await withMemo(new ClientScheme({ accountAddress: this.payer.accountAddress, signer: this.payer.signer }, this.grpc), memo).createPaymentPayload(2, req);
    // Fail closed if the transfer we signed does not carry exactly the memo asked for.
    const signed = memoOfSignedTransaction(r.payload.signedTransaction);
    if (signed !== memo) throw new Error(`signed payment carries memo ${JSON.stringify(signed)}, expected ${JSON.stringify(memo)}`);
    return { ...r, accepted: req } as PaymentPayload;
  }

  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    if (!this.facilitator) throw new Error("no facilitator configured");
    const v = await this.facilitator.verify(p, req);
    // The official facilitator ignores memos; Signet requires the order memo it asked for.
    if (v.isValid && req.extra?.memo !== undefined && memoOfSignedTransaction(p.payload?.signedTransaction) !== req.extra.memo)
      return { isValid: false, invalidReason: "memo_mismatch", payer: v.payer };
    return v;
  }

  async settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    if (!this.facilitator) throw new Error("no facilitator configured");
    return this.facilitator.settle(p, req);
  }

  explorerTx(hash: string) {
    return explorerTx(this.cfg, hash);
  }
}

/**
 * The official client always builds transfers without a memo (`buildCcdTransfer`, `buildPltTransfer`,
 * private in its types). This returns that client with both builders replaced on the instance by
 * memo-carrying versions; everything else (nonce, expiry, sponsor, chain decimals, signing, JSON) stays
 * the package's own. If a package update renames them we throw rather than pay without the memo, and
 * createPayment re-reads the signed transaction to be sure.
 */
function withMemo(client: ClientScheme, memo: string): ClientScheme {
  const c = client as unknown as Record<string, unknown>;
  if (typeof c.buildCcdTransfer !== "function" || typeof c.buildPltTransfer !== "function")
    throw new Error("@x402/concordium client changed: cannot attach the order memo");
  c.buildCcdTransfer = (payTo: string, amount: string) => ccdTransferWithMemo(payTo, amount, memo);
  c.buildPltTransfer = (payTo: string, amount: string, tokenId: string, decimals: number) => pltTransferWithMemo(payTo, amount, tokenId, decimals, memo);
  return client;
}

/** Native CCD transfer with the memo as a CBOR text string (same shape as the official client, plus memo). */
export function ccdTransferWithMemo(payTo: string, amount: string, memo: string) {
  const bytes = encodeMemo(memo);
  return Transaction.transfer({ toAddress: AccountAddress.fromBase58(payTo), amount: CcdAmount.fromMicroCcd(BigInt(amount)) }, new DataBlob(new Uint8Array(bytes).buffer));
}

/** PLT transfer (one operation) with the memo as a CBOR text string. */
export function pltTransferWithMemo(payTo: string, amount: string, tokenId: string, decimals: number, memo: string) {
  encodeMemo(memo); // length check
  return Transaction.tokenUpdate({
    tokenId: TokenId.fromString(tokenId),
    operations: Cbor.encode([
      {
        [TokenOperationType.Transfer]: {
          amount: TokenAmount.create(BigInt(amount), decimals),
          recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(payTo)),
          memo: CborMemo.fromString(memo),
        },
      },
    ]),
  });
}

/**
 * The memo text of a signed x402 Concordium payment (Transaction JSON as the client produces it):
 * a CCD transfer-with-memo, or a PLT token update holding exactly one transfer. Undefined for anything
 * else, including no memo, so callers comparing against an expected memo fail closed.
 */
export function memoOfSignedTransaction(json: unknown): string | undefined {
  try {
    const payload = (json as { payload?: Record<string, any> })?.payload;
    if (payload?.type === "transferWithMemo" && typeof payload.memo === "string") return decodeMemo(DataBlob.fromJSON(payload.memo).data);
    if (payload?.type === "tokenUpdate" && payload.operations !== undefined) {
      const ops = Cbor.decode(Cbor.fromJSON(payload.operations), "TokenOperation[]") as unknown[];
      if (!Array.isArray(ops) || ops.length !== 1) return undefined;
      const m = (ops[0] as Record<string, any>)?.[TokenOperationType.Transfer]?.memo;
      if (m instanceof Uint8Array) return decodeMemo(m);
      if (CborMemo.instanceOf(m)) return decodeMemo(m.content);
    }
  } catch {
    /* unreadable: no memo */
  }
  return undefined;
}
