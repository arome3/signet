import type { ConcordiumGRPCClient } from "@concordium/web-sdk";
import { IdentityProviderDID } from "@concordium/web-sdk/web3-id";
import { VerifiablePresentationV1, VerificationAuditRecordV1, VerificationRequestV1 } from "@concordium/web-sdk/wasm";
import { randomBytes } from "node:crypto";
import { randomHex } from "../core/canonical.js";
import type { AttributeProof, AttributeProver, AttributeVerifier } from "../core/types.js";
import type { LiveConfig, LoadedAccount } from "./config.js";

/**
 * Verify & Access, the same flow Concordium showed in Workshop 1, applied to agent commerce:
 *
 *   seller: VerificationRequestV1.createAndAnchor  -> CCDVRA anchor on chain (question, nonce, domain)
 *   buyer:  VerifiablePresentationV1.createFromAnchor with its identity commitment input
 *           (the agent's own identity from the Agent IDP, holding only the attributes its owner revealed)
 *   seller: VerificationAuditRecordV1.createAndAnchor -> verifies the ZK proof against the chain and
 *           registers a CCDVAA audit anchor (hash only), proving the check happened.
 *
 * Status: built on the published SDK API; needs a testnet run with an identity commitment input
 * (Agent IDP is on DevNet today; a normal testnet identity works for the human-owner variant).
 */
export async function createAgeRequest(
  cfg: LiveConfig,
  grpc: ConcordiumGRPCClient,
  anchorAccount: LoadedAccount,
  threshold: number,
  resource: string,
  issuers: number[],
): Promise<VerificationRequestV1.JSON> {
  const network = cfg.network === "mainnet" ? "Mainnet" : "Testnet";
  const ctx = VerificationRequestV1.createSimpleContext(randomBytes(32), randomHex(8), resource, `signet:age_over:${threshold}`);
  const claims = VerificationRequestV1.claimsBuilder()
    .addAccountOrIdentityClaims(issuers.map((i) => new IdentityProviderDID(network, i)), (b) => b.addMinimumAge(threshold))
    .getClaims();
  const req = await VerificationRequestV1.createAndAnchor(grpc, { sender: anchorAccount.accountAddress, signer: anchorAccount.signer }, { given: ctx.given, requested: ctx.requested }, claims, { app: "signet", kind: "age_over", threshold });
  return req.toJSON();
}

export class ConcordiumAttributeVerifier implements AttributeVerifier {
  constructor(
    private readonly cfg: LiveConfig,
    private readonly grpc: ConcordiumGRPCClient,
    /** If set, each successful check is anchored as a CCDVAA audit record from this account. */
    private readonly auditAccount?: LoadedAccount,
  ) {}

  async verify(_account: string, p: AttributeProof, _challenge: string, request?: unknown): Promise<boolean> {
    if (!request) return false;
    const network = this.cfg.network === "mainnet" ? "Mainnet" : "Testnet";
    const req = VerificationRequestV1.fromJSON(request as VerificationRequestV1.JSON);
    const pres = VerifiablePresentationV1.fromJSON(p.proof as VerifiablePresentationV1.JSON);
    const id = "signet-" + randomHex(8);
    const result = this.auditAccount
      ? await VerificationAuditRecordV1.createAndAnchor(id, req, pres, this.grpc, { metadata: { sender: this.auditAccount.accountAddress, signer: this.auditAccount.signer }, info: { app: "signet" } }, { network })
      : await VerificationAuditRecordV1.createChecked(id, req, pres, this.grpc, network);
    return (result as { type: string }).type === "success";
  }
}

/** Buyer side. `input` is the agent's identity commitment input (CommitmentInput) from its ID object. */
export class ConcordiumAttributeProver implements AttributeProver {
  constructor(
    private readonly grpc: ConcordiumGRPCClient,
    private readonly input: unknown,
  ) {}

  async prove(kind: "age_over", threshold: number, _challenge: string, request?: unknown): Promise<AttributeProof> {
    if (!request) throw new Error("live age proof needs the seller's anchored request");
    const req = VerificationRequestV1.fromJSON(request as VerificationRequestV1.JSON);
    const pres = await VerifiablePresentationV1.createFromAnchor(this.grpc, req, req.subjectClaims as never, [this.input as never], []);
    return { kind, threshold, proof: pres.toJSON() };
  }
}
