import { readFileSync } from "node:fs";
import { AccountAddress, buildAccountSigner, parseWallet, type AccountSigner } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { CONCORDIUM_TESTNET_CAIP2, CONCORDIUM_MAINNET_CAIP2 } from "@x402/concordium";

export type NetworkName = "testnet" | "mainnet";

export interface LiveConfig {
  network: NetworkName;
  caip2: string;
  grpcHost: string;
  grpcPort: number;
  /** Concordium's hosted Agent Registry MCP server (Streamable HTTP). */
  registryMcpUrl: string;
  /**
   * The CIS-8004 Agent Registry instance this deployment trusts. Any contract can implement CIS-8004,
   * so badges from other instances are refused ("verifiers choose which registries they trust").
   */
  registryContract: { index: bigint; subindex: bigint };
  /** PLT used for payments (testnet: request one via the PLT issuance form, or use USDR if you hold it). */
  asset: string;
  /** Identity-provider indices treated as agent / business issuers. Empty = auto-detect by IdP name. */
  agentIdps: number[];
  businessIdps: number[];
}

export function loadConfig(env = process.env): LiveConfig {
  const network = (env.SIGNET_NETWORK ?? "testnet") as NetworkName;
  const list = (v?: string) => (v ? v.split(",").map((x) => Number(x.trim())).filter(Number.isFinite) : []);
  return {
    network,
    caip2: network === "mainnet" ? CONCORDIUM_MAINNET_CAIP2 : CONCORDIUM_TESTNET_CAIP2,
    grpcHost: env.CCD_GRPC_HOST ?? (network === "mainnet" ? "grpc.mainnet.concordium.software" : "grpc.testnet.concordium.com"),
    grpcPort: Number(env.CCD_GRPC_PORT ?? 20000),
    registryMcpUrl: env.AGENT_REGISTRY_MCP_URL ?? "https://agent-registry-mcp.concordium.com/mcp",
    registryContract: parseContract(env.AGENT_REGISTRY_CONTRACT ?? (network === "mainnet" ? "10082,0" : "12802,0")),
    asset: env.SIGNET_ASSET ?? "USDR",
    agentIdps: list(env.AGENT_IDP_INDICES),
    businessIdps: list(env.BUSINESS_IDP_INDICES),
  };
}

function parseContract(v: string): { index: bigint; subindex: bigint } {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(v);
  if (!m) throw new Error(`AGENT_REGISTRY_CONTRACT must look like "12802,0", got "${v}"`);
  return { index: BigInt(m[1]), subindex: BigInt(m[2]) };
}

export function grpcClient(cfg: LiveConfig): ConcordiumGRPCNodeClient {
  return new ConcordiumGRPCNodeClient(cfg.grpcHost, cfg.grpcPort, credentials.createSsl(), { timeout: 15000 });
}

export interface LoadedAccount {
  address: string;
  accountAddress: AccountAddress.Type;
  signer: AccountSigner;
  /** First sign key, hex. Needed by @x402/concordium's facilitator signer. */
  privateKeyHex: string;
}

/**
 * Loads an account from a Concordium Wallet export (Browser Wallet: Settings > Export private key,
 * a JSON file with `value.accountKeys` and `value.address`).
 */
export function loadWalletExport(path: string): LoadedAccount {
  const wallet = parseWallet(readFileSync(path, "utf8"));
  const keys = wallet.value.accountKeys.keys as Record<string, { keys: Record<string, { signKey: string }> }>;
  const first = keys["0"]?.keys["0"]?.signKey;
  if (!first) throw new Error(`no sign key in ${path}`);
  return {
    address: wallet.value.address,
    accountAddress: AccountAddress.fromBase58(wallet.value.address),
    signer: buildAccountSigner(wallet),
    privateKeyHex: first,
  };
}

export function explorerTx(cfg: LiveConfig, hash: string) {
  return `https://ccdexplorer.io/${cfg.network}/transaction/${hash}`;
}
