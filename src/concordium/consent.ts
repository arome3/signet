import { TransactionHash, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import { VerifiablePresentationV1, VerificationAuditRecordV1, VerificationRequestV1 } from "@concordium/web-sdk/wasm";
import { randomBytes } from "node:crypto";
import { randomHex, sha256Hex } from "../core/canonical.js";
import { consentText } from "../core/consent.js";
import type { ConsentProvider, ConsentRequest, ConsentResult } from "../core/types.js";
import type { LiveConfig, LoadedAccount } from "./config.js";

/**
 * Delivers an anchored verification request to the owner's Concordium ID App and returns the
 * presentation JSON once the owner slides "approve". In Workshop 1 this was a QR code paired over
 * WalletConnect (method `request_verifiable_presentation_v1`, chain `ccd:<genesis>`), as wrapped by
 * @concordium/verification-web-ui. Plug a transport in that fits your surface (web page, Telegram,
 * terminal QR).
 */
export type PresentationTransport = (request: VerificationRequestV1.JSON, displayText: string) => Promise<unknown | undefined>;

/**
 * Human consent through the Concordium ID App, recorded on-chain:
 *   1. CCDVRA anchor: hash of the request whose context string is the exact consent sentence.
 *   2. Owner approves in the ID App; the app checks the text against the anchor before signing.
 *   3. CCDVAA anchor: hash of the audit record (request + presentation), so the approval can be
 *      proven later without publishing it.
 */
export class IdAppConsent implements ConsentProvider {
  constructor(
    private readonly cfg: LiveConfig,
    private readonly grpc: ConcordiumGRPCClient,
    /** Account that pays for the anchors (the agent's account, ideally sponsored). */
    private readonly anchorAccount: LoadedAccount,
    private readonly transport: PresentationTransport,
    private readonly resource = "signet://consent",
  ) {}

  async request(r: ConsentRequest): Promise<ConsentResult> {
    const text = consentText(r);
    const textHash = sha256Hex(text);
    const network = this.cfg.network === "mainnet" ? "Mainnet" : "Testnet";
    const ctx = VerificationRequestV1.createSimpleContext(randomBytes(32), randomHex(8), this.resource, text);
    const req = await VerificationRequestV1.createAndAnchor(
      this.grpc,
      { sender: this.anchorAccount.accountAddress, signer: this.anchorAccount.signer },
      { given: ctx.given, requested: ctx.requested },
      [],
      { app: "signet", kind: "consent", order: r.orderId, textHash },
    );
    const requestAnchorTx = TransactionHash.toHexString(req.transactionRef);
    const presentation = await this.transport(req.toJSON(), text);
    if (!presentation) return { approved: false, method: "concordium-id-app", requestAnchorTx, textHash };

    const result = await VerificationAuditRecordV1.createAndAnchor(
      "consent-" + r.orderId,
      req,
      VerifiablePresentationV1.fromJSON(presentation as VerifiablePresentationV1.JSON),
      this.grpc,
      { metadata: { sender: this.anchorAccount.accountAddress, signer: this.anchorAccount.signer }, info: { app: "signet", kind: "consent", order: r.orderId } },
      { network },
    );
    if (result.type !== "success") return { approved: false, method: "concordium-id-app", requestAnchorTx, textHash };
    return { approved: true, method: "concordium-id-app", requestAnchorTx, auditAnchorTx: TransactionHash.toHexString(result.result.anchorTransactionRef), textHash };
  }
}
