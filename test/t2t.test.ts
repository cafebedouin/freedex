// Swap, deposit and redeem against the real token-to-token pool script on the mock chain.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { SInt } from "@fleet-sdk/serializer";
import { T2T_POOL_TREE, buildDepositT2T, buildRedeemT2T, buildSwapT2T, depositQuoteT2T, describeT2TPool, quoteT2T, redeemQuoteT2T } from "../src/amm";
import { FEE } from "../src/orders";

const NFT = "11".repeat(32);
const LP = "22".repeat(32);
const X = "33".repeat(32);
const Y = "44".repeat(32);
const LP_MAX = 9_223_372_036_854_775_807n;

describe("token-to-token pool", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const user = chain.newParty("user");
  const pool = chain.addParty(T2T_POOL_TREE, "t2t pool");
  afterEach(() => chain.reset({ clearParties: true }));

  function seed(x: bigint, y: bigint, circulating: bigint, feeNum = 997) {
    pool.addBalance(
      { nanoergs: 10_000_000n, tokens: [{ tokenId: NFT, amount: 1n }, { tokenId: LP, amount: LP_MAX - circulating }, { tokenId: X, amount: x }, { tokenId: Y, amount: y }] },
      { R4: SInt(feeNum).toHex() },
    );
  }

  it("swaps X for Y and Y for X at the pool's rule", () => {
    seed(1_000_000n, 5_000_000n, 1_000n);
    user.addBalance({ nanoergs: 1_000_000_000n, tokens: [{ tokenId: X, amount: 10_000n }] });
    chain.addParty(user); chain.addParty(pool);
    const p = describeT2TPool(pool.utxos.at(0));
    const out = quoteT2T(p, X, 10_000n);
    expect(out).toBe((5_000_000n * 10_000n * 997n) / (1_000_000n * 1000n + 10_000n * 997n));
    const tx = buildSwapT2T({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), inId: X, amountIn: 10_000n, minOut: out });
    expect(chain.execute(tx, { signers: [user] })).toBe(true);
    expect(user.balance.tokens).toEqual([{ tokenId: Y, amount: out }]);
    const p1 = describeT2TPool(pool.utxos.at(0));
    expect(p1.x).toBe(1_010_000n);
    expect(p1.y).toBe(5_000_000n - out);
    // and back
    const back = quoteT2T(p1, Y, out);
    const tx2 = buildSwapT2T({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), inId: Y, amountIn: out, minOut: back });
    expect(chain.execute(tx2, { signers: [user] })).toBe(true);
    expect(user.balance.tokens).toEqual([{ tokenId: X, amount: back }]);
    expect(back).toBeLessThan(10_000n);
    expect(user.balance.nanoergs).toBe(1_000_000_000n - 2n * FEE);
  });

  it("the pool refuses one token too many", () => {
    seed(1_000_000n, 5_000_000n, 1_000n);
    user.addBalance({ nanoergs: 1_000_000_000n, tokens: [{ tokenId: X, amount: 10_000n }] });
    chain.addParty(user); chain.addParty(pool);
    const p = describeT2TPool(pool.utxos.at(0));
    const out = quoteT2T(p, X, 10_000n);
    const tx = buildSwapT2T({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), inId: X, amountIn: 10_000n, minOut: out });
    tx.outputs[0].assets[3].amount = (BigInt(tx.outputs[0].assets[3].amount) - 1n).toString();
    tx.outputs[1].assets[0].amount = (BigInt(tx.outputs[1].assets[0].amount) + 1n).toString();
    expect(chain.execute(tx, { signers: [user], throw: false })).toBe(false);
  });

  it("deposit then redeem returns the share", () => {
    seed(1_000_000n, 5_000_000n, 1_000_000n);
    user.addBalance({ nanoergs: 1_000_000_000n, tokens: [{ tokenId: X, amount: 10_000n }, { tokenId: Y, amount: 100_000n }] });
    chain.addParty(user); chain.addParty(pool);
    const p = describeT2TPool(pool.utxos.at(0));
    const q = depositQuoteT2T(p, 10_000n);
    expect(q.yIn).toBe(50_000n);
    expect(q.lpOut).toBe(10_000n);
    const dep = buildDepositT2T({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), xIn: 10_000n });
    expect(chain.execute(dep, { signers: [user] })).toBe(true);
    expect(user.balance.tokens).toEqual([{ tokenId: Y, amount: 50_000n }, { tokenId: LP, amount: 10_000n }]);
    const r = redeemQuoteT2T(describeT2TPool(pool.utxos.at(0)), 10_000n);
    expect(r).toEqual({ xOut: 10_000n, yOut: 50_000n });
    const red = buildRedeemT2T({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), lpIn: 10_000n });
    expect(chain.execute(red, { signers: [user] })).toBe(true);
    expect(user.balance.tokens).toEqual([{ tokenId: Y, amount: 100_000n }, { tokenId: X, amount: 10_000n }]);
  });
});
