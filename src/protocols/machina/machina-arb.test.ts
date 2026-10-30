// Orders priced across the pool, taken keylessly against both real scripts.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { SInt } from "@fleet-sdk/serializer";
import { LimitOrder } from "@nautls/machinafi-sdk";
import { POOL_TREE, describePool } from "../ergodex/amm";
import { buildOrderTake, sizeOrderTake } from "./machina-arb";
import { buildCreate, describe as view } from "./orders";

const NFT = "11".repeat(32),
  LP = "22".repeat(32),
  TOKEN = "33".repeat(32);
const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_775_807n;

describe("keyless Machina order takes", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const owner = chain.newParty("order owner");
  const taker = chain.newParty("taker");
  const pool = chain.addParty(POOL_TREE, "pool");
  const contract = chain.addParty(
    LimitOrder.create({
      owner: owner.address,
      type: "buy",
      price: 1n,
      assets: { base: { tokenId: "ERG", amount: 0n }, quote: { tokenId: TOKEN, amount: 1n } },
    }).ergoTree,
    "orders",
  );
  afterEach(() => chain.reset({ clearParties: true }));

  function seedPool() {
    // 20,000 nanoERG per unit
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
  }

  it("an order buying tokens above the pool is taken: pool to order, gap to the builder", () => {
    seedPool();
    owner.addBalance({ nanoergs: 2n * ERG });
    chain.addParty(pool);
    chain.addParty(owner);
    chain.addParty(contract);
    chain.addParty(taker);
    // owner buys tokens at 30,000: takers sell into it
    expect(
      chain.execute(
        buildCreate({
          height: chain.height,
          inputs: owner.utxos.toArray(),
          owner: owner.address,
          side: "buy-tokens",
          quoteTokenId: TOKEN,
          price: 30_000n,
          ergAmount: 1n * ERG,
        }),
        { signers: [owner] },
      ),
    ).toBe(true);
    const order = view(contract.utxos.at(0));
    expect(order.takerAction).toBe("sell");
    const size = sizeOrderTake(describePool(pool.utxos.at(0)), order)!;
    expect(size.payout).toBeGreaterThan(0n);
    const built = buildOrderTake({
      height: chain.height,
      poolBox: pool.utxos.at(0),
      orderBox: contract.utxos.at(0),
      payTo: taker.address,
    })!;
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
    expect(taker.balance.nanoergs).toBe(size.payout);
    expect(describePool(pool.utxos.at(0)).x).toBe(1_000n * ERG + size.poolErg);
  });

  it("an order selling tokens below the pool is taken: order to pool, gap to the builder", () => {
    seedPool();
    owner.addBalance({ nanoergs: 1n * ERG, tokens: [{ tokenId: TOKEN, amount: 10_000n }] });
    chain.addParty(pool);
    chain.addParty(owner);
    chain.addParty(contract);
    chain.addParty(taker);
    // owner sells tokens at 15,000: takers buy from it, below the pool's 20,000
    expect(
      chain.execute(
        buildCreate({
          height: chain.height,
          inputs: owner.utxos.toArray(),
          owner: owner.address,
          side: "sell-tokens",
          quoteTokenId: TOKEN,
          price: 15_000n,
          tokenAmount: 10_000n,
        }),
        { signers: [owner] },
      ),
    ).toBe(true);
    const order = view(contract.utxos.at(0));
    expect(order.takerAction).toBe("buy");
    const built = buildOrderTake({
      height: chain.height,
      poolBox: pool.utxos.at(0),
      orderBox: contract.utxos.at(0),
      payTo: taker.address,
    })!;
    expect(built.take.t).toBe(10_000n); // the whole order is below the pool, take it all
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
    expect(taker.balance.nanoergs).toBe(built.take.payout);
    expect(contract.utxos.length).toBe(0); // fully filled: paid out to the owner
    expect(owner.balance.nanoergs).toBeGreaterThan(0n);
  });

  it("nothing to take when the order sits inside the pool price", () => {
    seedPool();
    owner.addBalance({ nanoergs: 2n * ERG });
    chain.addParty(pool);
    chain.addParty(owner);
    chain.addParty(contract);
    chain.addParty(taker);
    expect(
      chain.execute(
        buildCreate({
          height: chain.height,
          inputs: owner.utxos.toArray(),
          owner: owner.address,
          side: "buy-tokens",
          quoteTokenId: TOKEN,
          price: 19_000n,
          ergAmount: 1n * ERG,
        }),
        { signers: [owner] },
      ),
    ).toBe(true);
    expect(
      buildOrderTake({
        height: chain.height,
        poolBox: pool.utxos.at(0),
        orderBox: contract.utxos.at(0),
        payTo: taker.address,
      }),
    ).toBeUndefined();
  });
});
