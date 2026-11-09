import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountAddress, CcdAmount, TransactionEventTag, TransactionKindString, TransactionStatusEnum } from "@concordium/web-sdk";
import { ConcordiumChainReader } from "../src/concordium/chain.js";
import { loadConfig } from "../src/concordium/config.js";

/** The live reader against stubbed gRPC responses shaped like @concordium/web-sdk 12's types. */
const acct = () => AccountAddress.fromBuffer(new Uint8Array(randomBytes(32)).buffer);
const A = acct();
const B = acct();
const reader = (summary: unknown, status = TransactionStatusEnum.Finalized) =>
  new ConcordiumChainReader(loadConfig({ SIGNET_NETWORK: "testnet" }), { getBlockItemStatus: async () => ({ status, outcome: { summary } }) } as any);
const tx = "ab".repeat(32);

describe("ConcordiumChainReader (stubbed gRPC)", () => {
  it("reads a native CCD payment as asset CCD in microCCD", async () => {
    const s = { transactionType: TransactionKindString.Transfer, sender: A, transfer: { tag: TransactionEventTag.Transferred, to: B, amount: CcdAmount.fromMicroCcd(2_500_000n) } };
    expect(await reader(s).transfers(tx)).toEqual([{ from: AccountAddress.toBase58(A), to: AccountAddress.toBase58(B), asset: "CCD", amount: "2500000" }]);
  });

  it("reads RegisterData anchors with their sender", async () => {
    const s = { transactionType: TransactionKindString.RegisterData, sender: A, dataRegistered: { tag: TransactionEventTag.DataRegistered, data: "a1b2" } };
    const r = await reader(s).registeredData(tx);
    expect(r?.sender).toBe(AccountAddress.toBase58(A));
    expect(Buffer.from(r!.data).toString("hex")).toBe("a1b2");
  });

  it("treats non-finalized or other transaction kinds as not found (fail closed)", async () => {
    const s = { transactionType: TransactionKindString.Transfer, sender: A, transfer: { tag: TransactionEventTag.Transferred, to: B, amount: CcdAmount.fromMicroCcd(1n) } };
    expect(await reader(s, TransactionStatusEnum.Committed).transfers(tx)).toBeUndefined();
    expect(await reader({ transactionType: TransactionKindString.RegisterData }).transfers(tx)).toBeUndefined();
    expect(await reader(s).registeredData(tx)).toBeUndefined();
  });
});

import { mandateFromMetadata } from "../src/concordium/registry.js";

describe("signet.mandate metadata parsing", () => {
  const h = "0f".repeat(32);
  it("accepts the hash as text, as UTF-8 hex, or as raw bytes, in any field name", () => {
    expect(mandateFromMetadata({ text: h, value_hex: Buffer.from(h).toString("hex") })).toBe(h);
    expect(mandateFromMetadata({ value_hex: Buffer.from(h).toString("hex") })).toBe(h);
    expect(mandateFromMetadata({ value_hex: h })).toBe(h);
    expect(mandateFromMetadata(h.toUpperCase())).toBe(h);
  });
  it("reads anything else as not published", () => {
    expect(mandateFromMetadata(null)).toBeUndefined();
    expect(mandateFromMetadata({ value_hex: "abcd", text: "pending" })).toBeUndefined();
  });
});
