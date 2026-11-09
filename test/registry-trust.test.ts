import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractAddress, tokenAddressFromBase58, tokenAddressToBase58 } from "@concordium/web-sdk";
import { loadConfig } from "../src/concordium/config.js";
import { badgeContractIssue, ConcordiumRegistry } from "../src/concordium/registry.js";

/** A real testnet badge: token 0 of the official CIS-8004 registry <12802,0>. */
const OFFICIAL = "JyP9TtQC3HCNrTYR3sc2T";
const onContract = (index: number) => tokenAddressToBase58({ contract: ContractAddress.create(index, 0), id: tokenAddressFromBase58(OFFICIAL).id });
const testnet = loadConfig({ SIGNET_NETWORK: "testnet" });

describe("trusted Agent Registry contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to <12802,0> on testnet and <10082,0> on mainnet, and can be overridden", () => {
    expect(testnet.registryContract).toEqual({ index: 12802n, subindex: 0n });
    expect(loadConfig({ SIGNET_NETWORK: "mainnet" }).registryContract).toEqual({ index: 10082n, subindex: 0n });
    expect(loadConfig({ AGENT_REGISTRY_CONTRACT: "7, 1" }).registryContract).toEqual({ index: 7n, subindex: 1n });
    expect(() => loadConfig({ AGENT_REGISTRY_CONTRACT: "twelve" })).toThrow(/AGENT_REGISTRY_CONTRACT/);
  });

  it("accepts badges of the trusted instance and refuses look-alike registries and garbage", () => {
    expect(badgeContractIssue(OFFICIAL, testnet.registryContract)).toBeUndefined();
    expect(badgeContractIssue(onContract(99999), testnet.registryContract)).toBe("untrusted_registry_contract");
    expect(badgeContractIssue(onContract(10082), testnet.registryContract)).toBe("untrusted_registry_contract"); // mainnet registry on testnet
    expect(badgeContractIssue("not-a-badge", testnet.registryContract)).toBe("badge_malformed");
  });

  it("refuses an agent registered in an attacker's own CIS-8004 contract without asking the registry", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("must not be called")));
    vi.stubGlobal("fetch", fetchSpy);
    const v = await new ConcordiumRegistry(testnet, {} as any, 0).check(onContract(99999));
    expect(v).toMatchObject({ verified: false, found: false, issues: ["untrusted_registry_contract"] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
