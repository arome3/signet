import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountAddress, DataBlob, SequenceNumber, TransactionExpiry, buildAccountSigner, signMessage, verifyMessageSignature } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { challengeMessage, newChallenge } from "../src/core/challenge.js";
import { encodeAnchor } from "../src/core/anchor.js";
import { sha256Hex } from "../src/core/canonical.js";
import { serializeAccountSignature } from "../src/concordium/account.js";
import { agentTokenIdParam, parseWalletNonce, setAgentWalletMessage } from "../src/concordium/agent-wallet.js";

/** Real Concordium SDK code paths that do not need a node: message signing and tx construction. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { priv, pub };
}
const A = AccountAddress.fromBuffer(new Uint8Array(randomBytes(32)).buffer);
const S = AccountAddress.fromBuffer(new Uint8Array(randomBytes(32)).buffer);

function accountInfo(address: AccountAddress.Type, pub: string) {
  return {
    accountAddress: address,
    accountThreshold: 1,
    accountCredentials: { 0: { v: 0, value: { type: "normal", contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: "Ed25519", verifyKey: pub } } } } } } },
  } as any;
}

describe("Concordium SDK integration (offline)", () => {
  it("signs and verifies a Signet challenge with the Concordium message scheme", async () => {
    const k = keypair();
    const msg = challengeMessage(newChallenge("ShopBadge", sha256Hex("order")));
    const sig = await signMessage(A, msg, buildAccountSigner(k.priv));
    expect(await verifyMessageSignature(msg, sig, accountInfo(A, k.pub))).toBe(true);
    expect(await verifyMessageSignature(msg + "x", sig, accountInfo(A, k.pub))).toBe(false);
    expect(await verifyMessageSignature(msg, sig, accountInfo(A, keypair().pub))).toBe(false);
  });

  it("builds a sponsored RegisterData anchor transaction signed by sender and sponsor", async () => {
    const sender = keypair();
    const sponsor = keypair();
    const data = encodeAnchor({ type: "SGNT", version: 1, root: sha256Hex("r"), from: 0, to: 9, head: sha256Hex("h") });
    const signable = Transaction.registerData({ data: new DataBlob(data.buffer.slice(0) as ArrayBuffer) })
      .addMetadata({ sender: A, nonce: SequenceNumber.create(1n), expiry: TransactionExpiry.futureMinutes(5) })
      .addSponsor(S)
      .build();
    const signed = await Transaction.sign(signable, buildAccountSigner(sender.priv));
    const sponsored = await Transaction.sponsor(signed as any, buildAccountSigner(sponsor.priv));
    const fin = Transaction.finalize(sponsored);
    expect(Transaction.getAccountTransactionHash(fin)).toHaveLength(32);
    expect((sponsored as any).signatures.sponsor).toBeDefined();
  });
});

describe("AccountSignatures wire form (for CIS-8004 setAgentWallet)", () => {
  it("serializes one credential with one key as count, index, count, index, Ed25519 tag, 64 bytes", () => {
    const sig = "ab".repeat(64);
    expect(serializeAccountSignature({ 0: { 0: sig } })).toBe("01" + "00" + "01" + "00" + "00" + sig);
  });

  it("orders credentials and keys by index and refuses anything that is not a 64-byte signature", () => {
    const [a, b, c] = ["aa", "bb", "cc"].map((x) => x.repeat(64));
    expect(serializeAccountSignature({ 1: { 0: c }, 0: { 2: b, 0: a } })).toBe("02" + "00" + "02" + "0000" + a + "0200" + b + "01" + "01" + "0000" + c);
    expect(() => serializeAccountSignature({ 0: { 0: "abcd" } })).toThrow(/64-byte/);
  });
});

describe("CIS-8004 setAgentWallet message (deployed contract layout)", () => {
  const fields = {
    tokenId: 1060n,
    owner: Buffer.alloc(32, 0x11),
    newWallet: Buffer.alloc(32, 0x22),
    nonce: 0n,
    deadlineMs: 1_800_000_000_000n,
    contract: { index: 12802n, subindex: 0n },
    genesisHash: Buffer.alloc(32, 0x33),
  };

  it("is 162 bytes: tag, token, owner, wallet, nonce, deadline, contract, genesis", () => {
    const m = setAgentWalletMessage(fields);
    expect(m.length).toBe(162);
    expect(m.subarray(0, 26).toString("ascii")).toBe("CIS-8004/v1/setAgentWallet");
    expect(m.readBigUInt64LE(26)).toBe(1060n);
    expect(m.subarray(34, 66).equals(fields.owner)).toBe(true);
    expect(m.subarray(66, 98).equals(fields.newWallet)).toBe(true);
    expect(m.readBigUInt64LE(98)).toBe(0n);
    expect(m.readBigUInt64LE(106)).toBe(1_800_000_000_000n);
    expect(m.readBigUInt64LE(114)).toBe(12802n);
    expect(m.readBigUInt64LE(122)).toBe(0n);
    expect(m.subarray(130).equals(fields.genesisHash)).toBe(true);
    expect(() => setAgentWalletMessage({ ...fields, owner: Buffer.alloc(31) })).toThrow(/32 bytes/);
  });

  it("reads the nonce raw (as the standard says) or Option-tagged (as testnet returns), nothing else", () => {
    const raw = Buffer.alloc(8);
    raw.writeBigUInt64LE(5n);
    expect(parseWalletNonce(raw)).toBe(5n);
    expect(parseWalletNonce(Buffer.from("010000000000000000", "hex"))).toBe(0n);
    expect(() => parseWalletNonce(Buffer.from("000000000000000000", "hex"))).toThrow(/unexpected/);
    expect(agentTokenIdParam(1060n).toString("hex")).toBe("082404000000000000");
  });
});
