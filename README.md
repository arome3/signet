# Signet

**The accountability layer for AI agents that pay.**

A Verified-by-Concordium badge proves a verified human or business stands behind an agent. It does *not* prove the agent has permission to spend. Signet adds that missing piece:

- **Mandates.** The owner signs spending limits for the agent: per payment, per day, a hard cap, blocked categories, and "verified businesses only". The mandate's hash is published in the agent's CIS-8004 metadata, so counterparties can see the agent's declared limits.
- **Human consent.** Anything outside the mandate goes to the owner as a Concordium ID App consent request. The request and the approval are both anchored on-chain (CCDVRA / CCDVAA), so the approval can't be disputed later.
- **Verified counterparties, both ways.**
  - The buyer checks the merchant's badge, the Agent Card hash and the business identity.
  - The merchant checks the buyer's badge and whether the account is an agent account.
  - Each side proves it controls its badge by signing a fresh challenge tied to the specific order. A copied badge string is useless.
- **Zero-knowledge age checks.** An age-restricted basket requires a Verify & Access proof that the agent's owner is at least 18, without revealing their date of birth.
- **Payments.** x402 "exact" payments on Concordium via the official `@x402/concordium` package: a stablecoin (protocol-level token) transfer, sponsored by the merchant's facilitator, so agents never hold CCD.
- **Audit trail.**
  - Every step goes into a hash-chained log, and Merkle roots are anchored with `RegisterData`.
  - The log produces an accountability report structured around EU AI Act Art. 12 record keeping.
  - The log holds no personal data. Lawful disclosure runs through Concordium's privacy guardians.

It plugs into any agent through an **MCP server** (`signet_buy`, `signet_audit`, `signet_anchor` and more). Agents call the MCP tools; merchants mount the Express app or middleware.

## Quick start (offline, about 1 minute)

```bash
npm install
npm test          # 26 tests: mandate engine, ledger, anchors, protocol attacks, Concordium SDK signing
npm run demo      # 7-scenario shopping demo on a local mock of Concordium
```

The demo runs these scenarios:

1. **Groceries:** inside the mandate, so the agent pays.
2. **Wine:** the merchant demands proof the owner is over 18, the agent proves it, and pays.
3. **Champagne:** over both the per-payment and daily limits, so the owner is asked, approves, and the agent pays.
4. **Cigarettes:** blocked by the mandate.
5. **Impostor "FreshMart":** its Agent Card was tampered with, so the agent refuses to pay it.
6. **Teen-owned agent buying wine:** the age proof fails, so the merchant refuses.
7. **Anonymous script:** gets a 403 before it is ever quoted a price.

Both sides' logs are anchored, and reports are written to `out/`.

## Use from Claude / any MCP client

```json
{ "mcpServers": { "signet": { "command": "npx", "args": ["tsx", "/ABS/PATH/signet/src/mcp/server.ts"] } } }
```

Mock mode starts a local FreshMart automatically. Ask your assistant to "buy 2 loaves of bread and a bottle of wine", then "show the audit".

## Run on Concordium testnet

1. Create test identities in the ID App or Browser Wallet (testnet):
   - a personal identity for the owner and agent;
   - a **Global FinReg** business identity for the merchant.
2. Request test CCD for the facilitator account (Activity > Request CCD).
3. Get a payment stablecoin on testnet. Either use USDR, if you hold some, or request your own via the PLT issuance form. Set `SIGNET_ASSET`.
4. Register both agents at https://agent-registry.concordium.com (testnet), host each Agent Card and set the URL and hash.
5. Export both accounts from the Browser Wallet into `keys/`, then fill in `.env` from `.env.example`.
6. Run `npm run demo:live`. It prints CCDExplorer links for the payments and the log anchors.

## Layout

```
src/core        mandate engine, hash-chained ledger, anchors, challenges, consent, report, wire protocol
src/buyer       SignetBuyer: verify merchant -> mandate -> consent -> prove -> pay -> log
src/seller      Express merchant: gate unverified agents, quote over x402, ZK age check, verify+settle
src/concordium  live adapters: Agent Registry MCP + gRPC, @x402/concordium rail, RegisterData anchors,
                Verify & Access age requests, ID App consent
src/mock        offline Concordium stand-in used by tests and the demo
src/mcp         MCP server for any agent framework
demo            scenario, offline runner, testnet runner
```

Status: built and tested offline (mock chain); the live Concordium testnet path is wired but not yet run end to end.
