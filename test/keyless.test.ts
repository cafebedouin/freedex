// keylessJson's id must equal the id Fleet computes for the same transaction.
import { describe, expect, it } from "vitest";
import { MockChain } from "@fleet-sdk/mock-chain";
import { OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import { keylessJson } from "../src/upkeep";
import { FEE } from "../src/protocols/machina/orders";

describe("keylessJson", () => {
  it("serializes to the same id as Fleet and leaves every proof empty", () => {
    const chain = new MockChain({ height: 1_900_000 });
    const a = chain.newParty("a");
    a.addBalance({
      nanoergs: 10_000_000_000n,
      tokens: [{ tokenId: "77".repeat(32), amount: 9_223_372_036_854_775_000n }],
    });
    const built = new TransactionBuilder(chain.height)
      .from(a.utxos.toArray())
      .to(new OutputBuilder(1_000_000n, a.address))
      .sendChangeTo(a.address)
      .payFee(FEE)
      .build();
    const { id, json } = keylessJson(built.toEIP12Object());
    expect(id).toBe(built.id);
    const parsed = JSON.parse(json) as {
      id: string;
      inputs: { spendingProof: { proofBytes: string } }[];
      outputs: { assets: { amount: unknown }[] }[];
    };
    expect(parsed.id).toBe(built.id);
    expect(parsed.inputs.every((i) => i.spendingProof.proofBytes === "")).toBe(true);
    expect(json).toContain("9223372036854775000"); // the 2^63-scale amount survives as an exact integer
  });
});
