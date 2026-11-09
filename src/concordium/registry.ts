import { AccountAddress, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import type { AgentRegistry, BadgeVerdict, OwnerKind } from "../core/types.js";
import type { LiveConfig } from "./config.js";

/**
 * Resolves badges against Concordium's CIS-8004 Agent Registry through the hosted Agent Registry
 * MCP server (stateless JSON-RPC over Streamable HTTP), then classifies the owner account by the
 * identity provider that issued its credential:
 *   - agent IdP (Agent IDP)      -> "agent"    (an agent account with selectively revealed owner attributes)
 *   - business IdP (Global FinReg) -> "business"
 *   - any other IdP              -> "human"
 *
 * Field names follow the hosted server's responses (owner_account, agent_wallet, agent_uri,
 * status, token_id_u64). Results are cached briefly; registry state changes are rare.
 */
export class ConcordiumRegistry implements AgentRegistry {
  private rpcId = 0;
  private cache = new Map<string, { at: number; v: BadgeVerdict }>();
  private idpKinds?: Map<number, OwnerKind>;

  constructor(
    private readonly cfg: LiveConfig,
    private readonly grpc: ConcordiumGRPCClient,
    private readonly ttlMs = 30_000,
  ) {}

  async check(badge: string): Promise<BadgeVerdict> {
    const hit = this.cache.get(badge);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v;
    const v = await this.resolve(badge);
    this.cache.set(badge, { at: Date.now(), v });
    return v;
  }

  private async resolve(badge: string): Promise<BadgeVerdict> {
    const base: BadgeVerdict = { badge, network: this.cfg.caip2, found: false, active: false, cardHashMatches: false, verified: false, ownerKind: "unknown", issues: [] };
    const rec = await this.tool("agent_by_token_address", { token_address: badge, network: this.cfg.network });
    if (rec.error || !rec.data || typeof rec.data !== "object") return { ...base, issues: ["not_registered", ...(rec.error ? [rec.error.slice(0, 160)] : [])] };
    const d = rec.data as Record<string, any>;
    const v: BadgeVerdict = {
      ...base,
      found: true,
      active: d.status === "Active",
      owner: d.owner_account ?? undefined,
      agentWallet: d.agent_wallet ?? undefined,
      agentUri: d.agent_uri ?? undefined,
    };
    if (!v.active) v.issues.push(`status_${d.status ?? "unknown"}`);
    const tokenId = d.token_id_u64 ?? d.token_id;

    if (!v.agentUri) v.issues.push("no_agent_card");
    else if (tokenId !== undefined) {
      const card = await this.tool("verify_agent_card", { token_id: String(tokenId), network: this.cfg.network });
      v.cardHashMatches = !card.error && (card.data as any)?.match === true;
      if (!v.cardHashMatches) v.issues.push("card_hash_mismatch");
    }
    if (tokenId !== undefined) {
      const meta = await this.tool("get_metadata", { token_id: String(tokenId), key: "signet.mandate", network: this.cfg.network });
      const val = (meta.data as any)?.value ?? (meta.data as any)?.value_hex;
      if (!meta.error && typeof val === "string") v.mandateHash = decodeMaybeHex(val);
    }
    if (v.owner) {
      const ip = await this.identityProviderOf(v.owner);
      v.identityProvider = ip;
      v.ownerKind = ip === undefined ? "unknown" : await this.kindOf(ip);
    }
    v.verified = v.found && v.active && v.cardHashMatches;
    return v;
  }

  async identityProviderOf(account: string): Promise<number | undefined> {
    try {
      const info = await this.grpc.getAccountInfo(AccountAddress.fromBase58(account));
      const cred = (info.accountCredentials as Record<string, any>)["0"];
      return cred?.value?.contents?.ipIdentity;
    } catch {
      return undefined;
    }
  }

  private async kindOf(ip: number): Promise<OwnerKind> {
    if (this.cfg.agentIdps.includes(ip)) return "agent";
    if (this.cfg.businessIdps.includes(ip)) return "business";
    if (!this.idpKinds) {
      this.idpKinds = new Map();
      try {
        for await (const idp of this.grpc.getIdentityProviders()) {
          const name = `${idp.ipDescription.name} ${idp.ipDescription.description}`.toLowerCase();
          this.idpKinds.set(idp.ipIdentity, /agent/.test(name) ? "agent" : /finreg|business|company|lei|kyb/.test(name) ? "business" : "human");
        }
      } catch {
        /* fall through to human */
      }
    }
    return this.idpKinds.get(ip) ?? "human";
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<{ data?: unknown; error?: string }> {
    try {
      const res = await fetch(this.cfg.registryMcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method: "tools/call", params: { name, arguments: args } }),
        signal: AbortSignal.timeout(15_000),
      });
      let body = await res.text();
      if (body.startsWith("event:") || body.startsWith("data:")) body = body.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? body;
      const msg = JSON.parse(body);
      if (msg.error) return { error: msg.error.message ?? JSON.stringify(msg.error) };
      const text = msg.result?.content?.[0]?.text ?? "";
      if (msg.result?.isError) return { error: text };
      if (msg.result?.structuredContent) return { data: msg.result.structuredContent };
      try {
        return { data: JSON.parse(text) };
      } catch {
        return { data: text };
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
}

function decodeMaybeHex(v: string): string {
  if (/^[0-9a-f]+$/i.test(v) && v.length !== 64 && v.length % 2 === 0) {
    const s = Buffer.from(v, "hex").toString("utf8");
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  }
  return v;
}
