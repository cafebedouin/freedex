// Deposit and redeem against the real N2T pool script on the mock chain.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { SInt } from "@fleet-sdk/serializer";
import { POOL_TREE, buildDeposit, buildRedeem, depositQuote, describePool, lpSupply, redeemQuote } from "../src/amm";
import { FEE } from "../src/orders";

const NFT = "37524493" + "0".repeat(56);
const LP = "05d8fdb5" + "0".repeat(56);
const TOKEN = "0f604d3d" + "0".repeat(56);
const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_775_807n;

describe("liquidity on an N2T pool", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const user = chain.newParty("user");
  const pool = chain.addParty(POOL_TREE, "pool");
  afterEach(() => chain.reset({ clearParties: true }));

  function seedPool(x: bigint, y: bigint, circulating: bigint) {
    pool.addBalance(
      { nanoergs: x, tokens: [{ tokenId: NFT, amount: 1n }, { tokenId: LP, amount: LP_MAX - circulating }, { tokenId: TOKEN, amount: y }] },
      { R4: SInt(997).toHex() },
    );
  }

  it("deposit earns LP at the pool's ratio, then redeem returns the share", () => {
    seedPool(1_000n * ERG, 50_000_000n, 1_000_000n);
    user.addBalance({ nanoergs: 12n * ERG, tokens: [{ tokenId: TOKEN, amount: 1_000_000n }] });
    chain.addParty(user); chain.addParty(pool);
    const p0 = describePool(pool.utxos.at(0));
    expect(lpSupply(p0)).toBe(1_000_000n);
    const q = depositQuote(p0, 10n * ERG);
    expect(q.tokenIn).toBe(500_000n); // 1% of the token reserve for 1% of the ERG reserve
    expect(q.lpOut).toBe(10_000n); // 1% of the supply

    const dep = buildDeposit({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), ergIn: 10n * ERG });
    expect(chain.execute(dep, { signers: [user] })).toBe(true);
    const p1 = describePool(pool.utxos.at(0));
    expect(p1.x).toBe(1_010n * ERG);
    expect(p1.y).toBe(50_500_000n);
    expect(lpSupply(p1)).toBe(1_010_000n);
    expect(user.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 500_000n }, { tokenId: LP, amount: 10_000n }]);

    const r = redeemQuote(p1, 10_000n);
    expect(r.ergOut).toBe(10n * ERG);
    expect(r.tokenOut).toBe(500_000n);
    const red = buildRedeem({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), lpIn: 10_000n });
    expect(chain.execute(red, { signers: [user] })).toBe(true);
    const p2 = describePool(pool.utxos.at(0));
    expect(p2.x).toBe(1_000n * ERG);
    expect(p2.y).toBe(50_000_000n);
    expect(user.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 1_000_000n }]);
    expect(user.balance.nanoergs).toBe(12n * ERG - 2n * FEE);
  });

  it("the pool refuses a deposit that claims one LP token too many", () => {
    seedPool(1_000n * ERG, 50_000_000n, 1_000_000n);
    user.addBalance({ nanoergs: 12n * ERG, tokens: [{ tokenId: TOKEN, amount: 1_000_000n }] });
    chain.addParty(user); chain.addParty(pool);
    const dep = buildDeposit({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), ergIn: 10n * ERG });
    const succ = dep.outputs[0], mine = dep.outputs[1];
    succ.assets[1].amount = (BigInt(succ.assets[1].amount) - 1n).toString();
    mine.assets[0].amount = (BigInt(mine.assets[0].amount) + 1n).toString();
    expect(chain.execute(dep, { signers: [user], throw: false })).toBe(false);
  });

  it("the pool refuses a redemption that takes one nanoERG too many", () => {
    seedPool(1_000n * ERG, 50_000_000n, 1_000_000n);
    user.addBalance({ nanoergs: 1n * ERG, tokens: [{ tokenId: LP, amount: 10_000n }] });
    chain.addParty(user); chain.addParty(pool);
    const red = buildRedeem({ height: chain.height, inputs: user.utxos.toArray(), user: user.address, poolBox: pool.utxos.at(0), lpIn: 10_000n });
    const succ = red.outputs[0], mine = red.outputs[1];
    succ.value = (BigInt(succ.value) - 1n).toString();
    mine.value = (BigInt(mine.value) + 1n).toString();
    expect(chain.execute(red, { signers: [user], throw: false })).toBe(false);
  });
});

describe("deposit quotes agree from either side", () => {
  it("tokens-first gives the ERG that ERG-first would have asked for the same tokens", async () => {
    const { depositQuote, depositQuoteFromTokens } = await import("../src/amm");
    const p = { boxId: "", nft: "", lpTokenId: "", lpReserved: 9_223_372_036_854_775_807n - 1_000_000n, tokenId: "", x: 1_000n * 1_000_000_000n, y: 50_000_000n, feeNum: 997n };
    const a = depositQuote(p, 10n * 1_000_000_000n);
    const b = depositQuoteFromTokens(p, a.tokenIn);
    expect(b.ergIn).toBe(10n * 1_000_000_000n);
    expect(b.lpOut).toBe(a.lpOut);
  });
});
