import { resolveTxt } from "node:dns/promises";
import type { DomainVerifier } from "../core/types.js";

/**
 * Domain proof via DNS: `_signet.<domain>` must carry a TXT record `signet-account=<account>`.
 * Lookup failures count as "not proven". Swap for Concordium domain verification once it is usable
 * from code (see the technical spec).
 */
export class DnsDomainVerifier implements DomainVerifier {
  async verify(domain: string, account: string): Promise<boolean> {
    try {
      const records = await resolveTxt(`_signet.${domain}`);
      return records.some((chunks) => chunks.join("") === `signet-account=${account}`);
    } catch {
      return false;
    }
  }
}
