// A taker sells tokens into an EIP-31 Babel box at its bid, against the real script on the mock chain.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { SGroupElement, SLong, SSigmaProp } from "@fleet-sdk/serializer";
import { SConstant } from "@fleet-sdk/serializer";
import { hex } from "@fleet-sdk/crypto";
import { babelCapacity, babelTree, buildFillBabel, describeBabel } from "./babel";
import { FEE } from "../machina/orders";

const TOKEN = "33".repeat(32);
const ERG = 1_000_000_000n;

describe("Babel fill", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const owner = chain.newParty("babel owner");
  const taker = chain.newParty("taker");
  const babel = chain.addParty(babelTree(TOKEN), "babel");
  afterEach(() => chain.reset({ clearParties: true }));

  function seed() {
    babel.addBalance(
      { nanoergs: 1n * ERG },
      { R4: SSigmaProp(SGroupElement(owner.key.publicKey)).toHex(), R5: SLong(30_000n).toHex() },
    );
    taker.addBalance({ nanoergs: 1n * ERG, tokens: [{ tokenId: TOKEN, amount: 10_000n }] });
    chain.addParty(babel);
    chain.addParty(taker);
  }

  it("pays the taker the bid for the tokens and recreates the box with them", () => {
    seed();
    const before = describeBabel(babel.utxos.at(0));
    expect(babelCapacity(before)).toBe(33_300n); // (1 ERG - the keep) / 30,000
    const tx = buildFillBabel({
      height: chain.height,
      inputs: taker.utxos.toArray(),
      taker: taker.address,
      babelBox: babel.utxos.at(0),
      tokenAmount: 1_000n,
    });
    expect(chain.execute(tx, { signers: [taker] })).toBe(true);
    expect(taker.balance.nanoergs).toBe(1n * ERG - FEE + 1_000n * 30_000n);
    expect(taker.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 9_000n }]);
    const after = describeBabel(babel.utxos.at(0));
    expect(after.tokens).toBe(1_000n);
    expect(after.value).toBe(1n * ERG - 30_000_000n);
    expect(after.bid).toBe(30_000n);
    expect(after.owner).toBe(owner.address.encode());
    expect(hex.encode(SConstant.from<Uint8Array>(babel.utxos.at(0).additionalRegisters.R6!).data)).toBe(before.boxId);
    // a second fill chains on the recreated box
    const tx2 = buildFillBabel({
      height: chain.height,
      inputs: taker.utxos.toArray(),
      taker: taker.address,
      babelBox: babel.utxos.at(0),
      tokenAmount: 500n,
    });
    expect(chain.execute(tx2, { signers: [taker] })).toBe(true);
    expect(describeBabel(babel.utxos.at(0)).tokens).toBe(1_500n);
  });

  it("refuses more than the box pays for, and nothing at all", () => {
    seed();
    const p = {
      height: chain.height,
      inputs: taker.utxos.toArray(),
      taker: taker.address,
      babelBox: babel.utxos.at(0),
    };
    expect(() => buildFillBabel({ ...p, tokenAmount: 33_301n })).toThrow(/at most 33300 units/);
    expect(() => buildFillBabel({ ...p, tokenAmount: 0n })).toThrow(/positive/);
  });

  it("one nanoERG more for the taker is refused by the script", () => {
    seed();
    const tx = buildFillBabel({
      height: chain.height,
      inputs: taker.utxos.toArray(),
      taker: taker.address,
      babelBox: babel.utxos.at(0),
      tokenAmount: 1_000n,
    });
    const change = tx.outputs.find((o) => o.ergoTree === taker.address.ergoTree)!;
    tx.outputs[0].value = (BigInt(tx.outputs[0].value) - 1n).toString();
    change.value = (BigInt(change.value) + 1n).toString();
    expect(chain.execute(tx, { signers: [taker], throw: false })).toBe(false);
    expect(describeBabel(babel.utxos.at(0)).tokens).toBe(0n);
  });
});
