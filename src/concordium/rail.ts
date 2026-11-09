import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { toConcordiumFacilitatorSigner } from "@x402/concordium";
import { ExactConcordiumScheme as ClientScheme } from "@x402/concordium/exact/client";
import { ExactConcordiumScheme as FacilitatorScheme } from "@x402/concordium/exact/facilitator";
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
  private facilitator?: FacilitatorScheme;

  constructor(
    private readonly cfg: LiveConfig,
    opts: { payer?: LoadedAccount; facilitator?: LoadedAccount },
  ) {
    this.network = cfg.caip2;
    const grpc = { grpcUrl: `${cfg.grpcHost}:${cfg.grpcPort}`, useTls: true };
    if (opts.payer) this.client = new ClientScheme({ accountAddress: opts.payer.accountAddress, signer: opts.payer.signer }, grpc);
    if (opts.facilitator) {
      this.feePayer = opts.facilitator.address;
      const signer = toConcordiumFacilitatorSigner(opts.facilitator.address, opts.facilitator.privateKeyHex, { host: cfg.grpcHost, port: cfg.grpcPort, useTls: true });
      this.facilitator = new FacilitatorScheme({ signer, requireFinalization: true });
    }
  }

  private feePayer?: string;

  async requirements({ payTo, asset, amount, maxTimeoutSeconds = 120 }: { payTo: string; asset: string; amount: bigint; maxTimeoutSeconds?: number }): Promise<PaymentRequirements> {
    if (!this.feePayer) throw new Error("seller rail needs a facilitator account");
    return { scheme: "exact", network: this.network as PaymentRequirements["network"], asset, amount: amount.toString(), payTo, maxTimeoutSeconds, extra: { feePayer: this.feePayer } };
  }

  async createPayment(req: PaymentRequirements): Promise<PaymentPayload> {
    if (!this.client) throw new Error("buyer rail needs a payer account");
    const r = await this.client.createPaymentPayload(2, req);
    return { ...r, accepted: req } as PaymentPayload;
  }

  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    if (!this.facilitator) throw new Error("no facilitator configured");
    return this.facilitator.verify(p, req);
  }

  async settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    if (!this.facilitator) throw new Error("no facilitator configured");
    return this.facilitator.settle(p, req);
  }

  explorerTx(hash: string) {
    return explorerTx(this.cfg, hash);
  }
}
