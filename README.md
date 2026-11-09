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
npm test          # 132 tests: mandate engine, ledger, anchors, receipts, order memos, directory, protocol attacks, SDK signing
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

Both sides' logs are anchored, every receipt is verified against the anchored log and the payment, and reports are written to `out/`.

What the merchant and buyer each check before money moves:

- **Merchant:** buyer badge and proof of control for this session and order; the owner-signed mandate (signature, published hash, agent, validity); its own mandate decision on the order, using the agent's signed spend-so-far (never below what the merchant has already received); an owner-signed approval when the mandate says ask; the age proof; payer = proven account. Each order and each signed payment is accepted once.
- **Buyer:** merchant badge and proof of control; a listing in the signed merchant directory that binds badge, brand, domain (DNS TXT proof) and endpoint; every quoted line at its listed price and category, exactly the items asked for; its own mandate and the owner's approval.
- **Anyone:** `verifyReceipt()` checks a receipt's merchant signature, the log entry that commits to it, the Merkle path to the anchored root, the anchor transaction's sender and contents, and the payment on chain, whose transfer memo must name the receipt's order (`signet:<orderHash>`).

## Use from Claude / any MCP client

```json
{ "mcpServers": { "signet": { "command": "npx", "args": ["tsx", "/ABS/PATH/signet/src/mcp/server.ts"] } } }
```

Mock mode starts a local FreshMart automatically. Ask your assistant to "buy 2 loaves of bread and a bottle of wine", then "show the audit".

## Run on Concordium testnet

1. In the Concordium Wallet (testnet), create a **Concordium testnet IP** identity with two accounts (owner, agent),
   and a **Global FinReg** business identity with one account (merchant). Request test CCD for all three accounts
   before anything else is sent to them (the faucet only serves accounts with no incoming transfers).
2. Export the three keys to `keys/owner.export`, `keys/agent.export`, `keys/merchant.export`, and fill in `.env`
   from `.env.example`. Payments can be in native CCD (`SIGNET_ASSET=CCD`) or a 6-decimal PLT.
3. `npm run testnet -- card agent <url>` (and `merchant`): host each Agent Card at that URL, byte for byte.
4. `npm run testnet -- register agent` (and `merchant`) mints the CIS-8004 badges. The **owner** registers and owns
   the agent's badge, so only the owner can change its mandate; `npm run testnet -- wallet agent` then makes the
   agent's account the badge's `agentWallet` (the agent signs, the owner sends). Then `card <role>` again and
   `pin <role>` to pin the final card, which carries its token address.
5. `npm run mandate:sign`, then `npm run testnet -- publish-mandate` (sent by the owner) sets `signet.mandate`.
   Merchants refuse a mandate whose owner is not the badge's owner.
6. Add the DNS TXT record `_signet.<domain>` = `signet-account=<merchant account>`, then `npm run directory:build`.
7. `npm run testnet -- check` until every line is ok, then `npm run demo:live`. Every CCDExplorer link (payments,
   anchors) is printed and written to `out/live-links.txt`, and each receipt is verified on chain.

Signet only trusts badges from the official registry instance (testnet `<12802,0>`, mainnet `<10082,0>`).

## Layout

```
src/core        mandate engine + signatures, hash-chained ledger, anchors, challenges, consent, receipts,
                merchant directory, report, wire protocol
src/buyer       SignetBuyer: verify merchant -> mandate -> consent -> prove -> pay -> log
src/seller      Express merchant: gate unverified agents, quote over x402, ZK age check, verify+settle
src/concordium  live adapters: Agent Registry MCP + gRPC, @x402/concordium rail, RegisterData anchors,
                Verify & Access age requests, ID App consent
src/mock        offline Concordium stand-in used by tests and the demo
src/mcp         MCP server for any agent framework
scripts         mandate:sign, directory:build (testnet setup)
demo            scenario, offline runner, testnet runner
```

Status: built and tested offline (mock chain); the live Concordium testnet path is wired but not yet run end to end.
