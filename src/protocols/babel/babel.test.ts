// A Babel bid above the pool price, taken keylessly against the real pool and EIP-31 scripts on the mock chain.
import { MockChain } from "@fleet-sdk/mock-chain";
import { describe, expect, it, afterEach } from "vitest";
import { SGroupElement, SInt, SLong, SSigmaProp } from "@fleet-sdk/serializer";
import { POOL_TREE, describePool } from "../ergodex/amm";
import { babelTree, buildBabelTake, describeBabel, sizeBabelTake } from "./babel";
import { FEE } from "../machina/orders";

const NFT = "11".repeat(32),
  LP = "22".repeat(32),
  TOKEN = "33".repeat(32);
const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_775_807n;

describe("keyless Babel take", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const owner = chain.newParty("babel owner");
  const taker = chain.newParty("taker");
  const pool = chain.addParty(POOL_TREE, "pool");
  const babel = chain.addParty(babelTree(TOKEN), "babel");
  afterEach(() => chain.reset({ clearParties: true }));

  function seed(bid: bigint) {
    pool.addBalance(
      {
        nanoergs: 1_000n * ERG,
        tokens: [
          { tokenId: NFT, amount: 1n },
          { tokenId: LP, amount: LP_MAX - 1_000_000n },
          { tokenId: TOKEN, amount: 50_000_000n },
        ],
      },
      { R4: SInt(997).toHex() },
    );
    // pool price: 20,000 nanoERG per unit; the Babel bid sits above it
    babel.addBalance(
      { nanoergs: 1n * ERG },
      { R4: SSigmaProp(SGroupElement(owner.key.publicKey)).toHex(), R5: SLong(bid).toHex() },
    );
    chain.addParty(pool);
    chain.addParty(babel);
    chain.addParty(taker);
  }

  it("takes the gap with no signature and pays the builder", () => {
    seed(30_000n);
    const p = describePool(pool.utxos.at(0)),
      b = describeBabel(babel.utxos.at(0));
    expect(b.bid).toBe(30_000n);
    const size = sizeBabelTake(p, b)!;
    expect(size.payout).toBeGreaterThan(0n);
    const built = buildBabelTake({
      height: chain.height,
      poolBox: pool.utxos.at(0),
      babelBox: babel.utxos.at(0),
      payTo: taker.address,
    })!;
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
    expect(taker.balance.nanoergs).toBe(size.payout);
    const b1 = describeBabel(babel.utxos.at(0));
    expect(b1.tokens).toBe(size.t);
    expect(b1.value).toBe(1n * ERG - size.y);
    expect(describePool(pool.utxos.at(0)).x).toBe(1_000n * ERG + size.dx);
    // the whole gap went to the taker and the fee, nothing else
    expect(size.y).toBe(size.dx + size.payout + FEE);
  });

  it("finds nothing to take when the bid is below the pool", () => {
    seed(10_000n);
    expect(sizeBabelTake(describePool(pool.utxos.at(0)), describeBabel(babel.utxos.at(0)))).toBeUndefined();
    expect(
      buildBabelTake({
        height: chain.height,
        poolBox: pool.utxos.at(0),
        babelBox: babel.utxos.at(0),
        payTo: taker.address,
      }),
    ).toBeUndefined();
  });

  it("one nanoERG more for the taker is refused by the Babel script", () => {
    seed(30_000n);
    const built = buildBabelTake({
      height: chain.height,
      poolBox: pool.utxos.at(0),
      babelBox: babel.utxos.at(0),
      payTo: taker.address,
    })!;
    built.tx.outputs[1].value = (BigInt(built.tx.outputs[1].value) - 1n).toString();
    built.tx.outputs[2].value = (BigInt(built.tx.outputs[2].value) + 1n).toString();
    expect(chain.execute(built.tx, { signers: [], throw: false })).toBe(false);
  });
});
