// The direct swap against the real ErgoDEX v1 N2T pool script on Fleet's mock chain.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { SInt } from "@fleet-sdk/serializer";
import { POOL_TREE, buildSwap, describePool, quote } from "../src/amm";
import { FEE } from "../src/orders";

const NFT = "37524493" + "0".repeat(56);
const LP = "05d8fdb5" + "0".repeat(56);
const TOKEN = "0f604d3d" + "0".repeat(56);
const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_774_807n;

describe("direct swap on an N2T pool", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const user = chain.newParty("user");
  const pool = chain.addParty(POOL_TREE, "pool");
  afterEach(() => chain.reset({ clearParties: true }));

  function seedPool(x: bigint, y: bigint, feeNum: number) {
    pool.addBalance(
      { nanoergs: x, tokens: [{ tokenId: NFT, amount: 1n }, { tokenId: LP, amount: LP_MAX - 1_000_000n }, { tokenId: TOKEN, amount: y }] },
      { R4: SInt(feeNum).toHex() },
    );
  }

  it("ERG to token at the pool's rule", () => {
    seedPool(1_000n * ERG, 50_000_000n, 997);
    user.addBalance({ nanoergs: 5n * ERG });
    chain.addParty(user); chain.addParty(pool);
    const p = describePool(pool.utxos.at(0));
    const out = quote(p, "erg-to-token", 1n * ERG);
    expect(out).toBe((50_000_000n * 1n * ERG * 997n) / (1_000n * ERG * 1000n + 1n * ERG * 997n));
    const tx = buildSwap({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), direction: "erg-to-token", amountIn: 1n * ERG, minOut: out });
    expect(chain.execute(tx, { signers: [user] })).toBe(true);
    expect(user.balance.tokens).toEqual([{ tokenId: TOKEN, amount: out }]);
    const after = describePool(pool.utxos.at(0));
    expect(after.x).toBe(1_001n * ERG);
    expect(after.y).toBe(50_000_000n - out);
    expect(user.balance.nanoergs).toBe(5n * ERG - 1n * ERG - FEE);
  });

  it("token to ERG at the pool's rule", () => {
    seedPool(1_000n * ERG, 50_000_000n, 997);
    user.addBalance({ nanoergs: 1n * ERG, tokens: [{ tokenId: TOKEN, amount: 100_000n }] });
    chain.addParty(user); chain.addParty(pool);
    const p = describePool(pool.utxos.at(0));
    const out = quote(p, "token-to-erg", 100_000n);
    const tx = buildSwap({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), direction: "token-to-erg", amountIn: 100_000n, minOut: out });
    expect(chain.execute(tx, { signers: [user] })).toBe(true);
    expect(user.balance.tokens).toEqual([]);
    expect(user.balance.nanoergs).toBe(1n * ERG + out - FEE);
    expect(describePool(pool.utxos.at(0)).y).toBe(50_100_000n);
  });

  it("taking one token more than the rule allows is refused by the pool", () => {
    seedPool(1_000n * ERG, 50_000_000n, 997);
    user.addBalance({ nanoergs: 5n * ERG });
    chain.addParty(user); chain.addParty(pool);
    const p = describePool(pool.utxos.at(0));
    const out = quote(p, "erg-to-token", 1n * ERG);
    const tx = buildSwap({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), direction: "erg-to-token", amountIn: 1n * ERG, minOut: out });
    // move one token from the pool successor to the user's output
    const succ = tx.outputs[0], mine = tx.outputs[1];
    succ.assets[2].amount = (BigInt(succ.assets[2].amount) - 1n).toString();
    mine.assets[0].amount = (BigInt(mine.assets[0].amount) + 1n).toString();
    expect(chain.execute(tx, { signers: [user], throw: false })).toBe(false);
    expect(describePool(pool.utxos.at(0)).y).toBe(50_000_000n);
  });

  it("the slippage guard refuses a stale quote", () => {
    seedPool(1_000n * ERG, 50_000_000n, 997);
    user.addBalance({ nanoergs: 5n * ERG });
    chain.addParty(user); chain.addParty(pool);
    const p = describePool(pool.utxos.at(0));
    const out = quote(p, "erg-to-token", 1n * ERG);
    expect(() => buildSwap({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), direction: "erg-to-token", amountIn: 1n * ERG, minOut: out + 1n })).toThrow(/below the minimum/);
  });
});
