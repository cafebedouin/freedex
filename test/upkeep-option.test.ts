// The expired-option finder: options whose writer is the visitor and whose expiry has passed, nothing else.
import { MockChain } from "@fleet-sdk/mock-chain";
import { describe, expect, it } from "vitest";
import type { Explorer } from "../src/explorer";
import { CALL_TEMPLATE_SHA256, CALL_TREE, PUT_TEMPLATE_SHA256, PUT_TREE, buildBuy, buildWrite } from "../src/option";
import { expiredOptionsFor } from "../src/upkeep";

const ERG = 1_000_000_000n;
const TOKEN = "66".repeat(32);

describe("expiredOptionsFor", () => {
  it("picks the expired options the visitor wrote, sold or not, and leaves the others", async () => {
    const chain = new MockChain({ height: 1_900_000 });
    const me = chain.newParty("me"),
      other = chain.newParty("other");
    const calls = chain.addParty(CALL_TREE, "calls"),
      puts = chain.addParty(PUT_TREE, "puts");
    me.addBalance({ nanoergs: 50n * ERG, tokens: [{ tokenId: TOKEN, amount: 1_000n }] });
    other.addBalance({ nanoergs: 50n * ERG, tokens: [{ tokenId: TOKEN, amount: 1_000n }] });
    const base = chain.height; // the mock chain advances a block per transaction: expiries are set from here
    const write = (side: "call" | "put", writer: typeof me, term: number) =>
      expect(
        chain.execute(
          buildWrite({
            side,
            writer: writer.address,
            tokenId: TOKEN,
            amount: 10n,
            strike: 100_000n,
            expiry: base + term,
            premium: 1_000_000n,
            height: chain.height,
            inputs: writer.utxos.toArray(),
          }),
          { signers: [writer] },
        ),
      ).toBe(true);
    write("call", me, 100); // mine, expires, unsold
    write("put", me, 100); // mine, expires, sold below
    write("call", me, 10_000); // mine, not expired
    write("call", other, 100); // someone else's, expires
    expect(
      chain.execute(
        buildBuy({
          height: chain.height,
          inputs: other.utxos.toArray(),
          buyer: other.address,
          optionBox: puts.utxos.at(0),
        }),
        { signers: [other] },
      ),
    ).toBe(true);
    chain.jumpTo(base + 100);
    const explorer = {
      byTemplate: async (hash: string) =>
        hash === CALL_TEMPLATE_SHA256
          ? calls.utxos.toArray()
          : hash === PUT_TEMPLATE_SHA256
            ? puts.utxos.toArray()
            : [],
    } as unknown as Explorer;
    const due = await expiredOptionsFor(explorer, chain.height, [me.address.encode()]);
    expect(due.map((d) => d.v.side).sort()).toEqual(["call", "put"]);
    expect(due.every((d) => d.v.writer === me.address.encode() && d.v.expiry <= chain.height)).toBe(true);
    expect(due.find((d) => d.v.side === "put")!.v.sold).toBe(true);
    // one block earlier nothing has expired; with no addresses nothing and no explorer call
    expect(await expiredOptionsFor(explorer, chain.height - 1, [me.address.encode()])).toEqual([]);
    let called = 0;
    const counting = { byTemplate: async () => (called++, []) } as unknown as Explorer;
    expect(await expiredOptionsFor(counting, chain.height, [])).toEqual([]);
    expect(called).toBe(0);
  });
});
