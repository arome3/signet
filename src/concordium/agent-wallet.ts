/**
 * CIS-8004 `setAgentWallet` proof, as the deployed registry checks it (confirmed by dry runs against
 * testnet <12802,0> on 9 Nov 2026). The new wallet's account signs, with plain Ed25519 (no wallet
 * message prefix), the standard's 162-byte message:
 *
 *   "CIS-8004/v1/setAgentWallet" (26) | token_id u64 LE (8) | owner (32) | new_wallet (32)
 *   | wallet_set_nonce u64 LE (8) | deadline ms u64 LE (8) | contract index, subindex u64 LE (16) | genesis hash (32)
 *
 * The signature goes in the parameter as serialized AccountSignatures inside a u32-length byte string
 * (the registry MCP's `build_set_agent_wallet` adds the length). The MCP's own
 * `set_agent_wallet_canonical_bytes` returns an older 122-byte layout without owner and nonce, which the
 * deployed contract rejects (InvalidAgentWalletProof, -7212).
 */
export const SET_AGENT_WALLET_TAG = "CIS-8004/v1/setAgentWallet";

export interface SetAgentWalletFields {
  tokenId: bigint;
  /** 32-byte account addresses (AccountAddress.toBuffer). */
  owner: Uint8Array;
  newWallet: Uint8Array;
  nonce: bigint;
  deadlineMs: bigint;
  contract: { index: bigint; subindex: bigint };
  /** 32-byte genesis block hash of the chain. */
  genesisHash: Uint8Array;
}

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

export function setAgentWalletMessage(f: SetAgentWalletFields): Buffer {
  for (const [name, v] of [["owner", f.owner], ["newWallet", f.newWallet], ["genesisHash", f.genesisHash]] as const)
    if (v.length !== 32) throw new Error(`${name} must be 32 bytes, got ${v.length}`);
  const msg = Buffer.concat([
    Buffer.from(SET_AGENT_WALLET_TAG, "ascii"),
    u64(f.tokenId),
    Buffer.from(f.owner),
    Buffer.from(f.newWallet),
    u64(f.nonce),
    u64(f.deadlineMs),
    u64(f.contract.index),
    u64(f.contract.subindex),
    Buffer.from(f.genesisHash),
  ]);
  if (msg.length !== 162) throw new Error(`setAgentWallet message is ${msg.length} bytes, expected 162`);
  return msg;
}

/**
 * `getAgentWalletNonce` return value. The standard says raw u64 LE (8 bytes); the deployed contract
 * returns it Option-tagged (0x01 then u64 LE, 9 bytes). Anything else is refused.
 */
export function parseWalletNonce(ret: Uint8Array): bigint {
  const b = Buffer.from(ret);
  if (b.length === 8) return b.readBigUInt64LE(0);
  if (b.length === 9 && b[0] === 1) return b.readBigUInt64LE(1);
  throw new Error(`unexpected getAgentWalletNonce return value (${b.length} bytes)`);
}

/** CIS-8004 AgentTokenId wire form: length byte 8, then the u64 LE token id. */
export function agentTokenIdParam(tokenId: bigint): Buffer {
  return Buffer.concat([Buffer.from([8]), u64(tokenId)]);
}
