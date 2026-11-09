import { readFileSync } from "node:fs";
import { MandateSchema, type SignedMandate } from "./mandate.js";

/**
 * Loads an owner-signed mandate written by `npm run mandate:sign`. Throws (refusing to start) when the
 * file is missing, is an unsigned mandate, or was signed for another agent badge.
 */
export function loadSignedMandate(path: string, badge: string): SignedMandate {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read signed mandate ${path} (${(e as Error).message}); run \`npm run mandate:sign\``);
  }
  const sm = raw as Partial<SignedMandate>;
  if (!sm.mandate || !sm.ownerSignature) throw new Error(`${path} is not a signed mandate; run \`npm run mandate:sign\``);
  const mandate = MandateSchema.parse(sm.mandate);
  if (mandate.agent !== badge) throw new Error(`${path} was signed for agent ${mandate.agent}, not ${badge}`);
  return { mandate, ownerSignature: sm.ownerSignature };
}
