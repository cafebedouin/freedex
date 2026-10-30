// A clocked-box leg sized by sizeLeg is accepted by the script at its due height and refused one block early, over
// random pools and programs on both sides. The mock chain evaluates at HEIGHT = chain.height + 1, so the script's
// due height is chain.height = created + interval - 1, and the builder (one block more conservative, it waits for
// the explorer's height to reach created + interval) builds at chain.height = created + interval.
import { MockChain } from "@fleet-sdk/mock-chain";
import { describe, expect, it } from "vitest";
import { SInt } from "@fleet-sdk/serializer";
import fc from "fast-check";
import { POOL_TREE, describePool, quote } from "../../src/protocols/ergodex/amm";
import {
  CLOCK_SELL_TREE,
  CLOCK_TREE,
  OWNER_BOX_VALUE,
  buildCreateClock,
  buildCreateClockSell,
  buildLeg,
  describeClock,
  sizeLeg,
} from "../../src/protocols/clock/clock";
import { FEE } from "../../src/protocols/machina/orders";
import { big, feeNum, report } from "./setup";

const NFT = "11".repeat(32),
  LP = "22".repeat(32),
  TOKEN = "33".repeat(32);
const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_775_807n;

/** A pool of 10 to 100,000 ERG at 1 to 100,000 nanoERG per unit. */
const poolCase = fc.record({ x: big(10n * ERG, 100_000n * ERG), price: big(1n, 100_000n), fee: feeNum });
const programCase = fc.record({
  slice: big(1_000_000n, 1n * ERG),
  interval: fc.integer({ min: 1, max: 60 }),
  toleranceBps: big(0n, 500n),
  executorFee: big(FEE + OWNER_BOX_VALUE + 1n, 10_000_000n),
  legs: fc.integer({ min: 1, max: 4 }),
});

describe("the clocked box, buy side: sizeLeg's leg at the due height, refused a block early", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const owner = chain.newParty("owner");
  const executor = chain.newParty("executor");
  const pool = chain.addParty(POOL_TREE, "pool");
  const clock = chain.addParty(CLOCK_TREE, "clock");

  it("over random pools and programs", () => {
    const N = 25;
    fc.assert(
      fc.property(poolCase, programCase, (pc, pr) => {
        chain.reset({ clearParties: true });
        pool.addBalance(
          {
            nanoergs: pc.x,
            tokens: [
              { tokenId: NFT, amount: 1n },
              { tokenId: LP, amount: LP_MAX - 1_000_000n },
              { tokenId: TOKEN, amount: pc.x / pc.price },
            ],
          },
          { R4: SInt(Number(pc.fee)).toHex() },
        );
        owner.addBalance({ nanoergs: BigInt(pr.legs) * (pr.slice + pr.executorFee) + 1n * ERG });
        executor.addBalance({ nanoergs: 1n * ERG });
        for (const p of [owner, executor, pool, clock]) chain.addParty(p);
        const program = {
          owner: owner.address,
          tokenId: TOKEN,
          poolBox: pool.utxos.at(0),
          slice: pr.slice,
          interval: pr.interval,
          toleranceBps: pr.toleranceBps,
          executorFee: pr.executorFee,
          maxPrice: 0n,
          legs: pr.legs,
        };
        const built = chain.height;
        expect(
          chain.execute(buildCreateClock({ ...program, height: built, inputs: owner.utxos.toArray() }), {
            signers: [owner],
          }),
        ).toBe(true);
        const v = describeClock(clock.utxos.at(0));
        const created = built + 1;
        expect(v.creationHeight).toBe(created);
        const size = sizeLeg(describePool(pool.utxos.at(0)), v);
        fc.pre(size.got > 0n); // a slice too small for one token unit is not a leg
        const leg = (height: number, force: boolean) =>
          buildLeg({ height, poolBox: pool.utxos.at(0), clockBox: clock.utxos.at(0), payTo: executor.address }, force);
        // one block before the script's due height: refused, with a successor the successor rule would accept
        chain.jumpTo(created + pr.interval - 2);
        expect(leg(chain.height, false)).toBeUndefined();
        const early = leg(chain.height, true)!;
        if (!size.last) early.tx.outputs[2].creationHeight = created + pr.interval;
        expect(chain.execute(early.tx, { signers: [], throw: false })).toBe(false);
        // the script's due height: accepted (forced past the builder's own one-block margin)
        chain.jumpTo(created + pr.interval - 1);
        expect(leg(chain.height, false)).toBeUndefined();
        const due = leg(chain.height, true)!;
        expect(due.size).toEqual(size);
        expect(chain.execute(due.tx, { signers: [] })).toBe(true);
        expect(owner.balance.tokens).toEqual([{ tokenId: TOKEN, amount: size.got }]);
        expect(executor.balance.nanoergs).toBe(1n * ERG + size.payout);
        if (size.last) expect(clock.utxos.length).toBe(0);
        else {
          const after = describeClock(clock.utxos.at(0));
          expect(after.creationHeight).toBe(chain.height); // the block it was mined in: the clock restarts
          expect(after.value).toBe(v.value - pr.slice - pr.executorFee);
        }
      }),
      { numRuns: N },
    );
    report("clock: buy leg at the due height", N);
  });
});

describe("the tranche sale, sell side: the same", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const owner = chain.newParty("owner");
  const executor = chain.newParty("executor");
  const pool = chain.addParty(POOL_TREE, "pool");
  const clock = chain.addParty(CLOCK_SELL_TREE, "clock");
  const sellCase = fc.record({
    slice: big(1n, 100_000n),
    legs: fc.integer({ min: 1, max: 4 }),
    rest: big(0n, 99_999n),
    interval: fc.integer({ min: 1, max: 60 }),
    toleranceBps: big(0n, 500n),
    executorFee: big(FEE + OWNER_BOX_VALUE + 1n, 10_000_000n),
  });

  it("over random pools and programs", () => {
    const N = 25;
    fc.assert(
      fc.property(poolCase, sellCase, (pc, pr) => {
        chain.reset({ clearParties: true });
        const y = pc.x / pc.price;
        const tokens = BigInt(pr.legs) * pr.slice + (pr.rest % pr.slice);
        fc.pre(tokens < y / 10n); // a sale that is a fraction of the pool
        pool.addBalance(
          {
            nanoergs: pc.x,
            tokens: [
              { tokenId: NFT, amount: 1n },
              { tokenId: LP, amount: LP_MAX - 1_000_000n },
              { tokenId: TOKEN, amount: y },
            ],
          },
          { R4: SInt(Number(pc.fee)).toHex() },
        );
        owner.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: TOKEN, amount: tokens }] });
        executor.addBalance({ nanoergs: 1n * ERG });
        for (const p of [owner, executor, pool, clock]) chain.addParty(p);
        const program = {
          owner: owner.address,
          tokenId: TOKEN,
          poolBox: pool.utxos.at(0),
          tokens,
          slice: pr.slice,
          interval: pr.interval,
          toleranceBps: pr.toleranceBps,
          executorFee: pr.executorFee,
          minPrice: 0n,
        };
        const built = chain.height;
        expect(
          chain.execute(buildCreateClockSell({ ...program, height: built, inputs: owner.utxos.toArray() }), {
            signers: [owner],
          }),
        ).toBe(true);
        const v = describeClock(clock.utxos.at(0));
        const created = built + 1;
        const size = sizeLeg(describePool(pool.utxos.at(0)), v);
        fc.pre(size.got > 0n);
        const leg = (height: number, force: boolean) =>
          buildLeg({ height, poolBox: pool.utxos.at(0), clockBox: clock.utxos.at(0), payTo: executor.address }, force);
        chain.jumpTo(created + pr.interval - 2);
        expect(leg(chain.height, false)).toBeUndefined();
        const early = leg(chain.height, true)!;
        if (!size.last) early.tx.outputs[2].creationHeight = created + pr.interval;
        expect(chain.execute(early.tx, { signers: [], throw: false })).toBe(false);
        chain.jumpTo(created + pr.interval - 1);
        const due = leg(chain.height, true)!;
        expect(due.size).toEqual(size);
        const ownerErg = owner.balance.nanoergs;
        expect(chain.execute(due.tx, { signers: [] })).toBe(true);
        expect(owner.balance.nanoergs - ownerErg).toBe(size.ownerValue);
        expect(size.got).toBe(quote(describePool(pool.utxos.at(0)), "token-to-erg", 0n) + size.got); // the quote was taken before the trade
        expect(executor.balance.nanoergs).toBe(1n * ERG + size.payout);
        if (size.last) expect(clock.utxos.length).toBe(0);
        else expect(describeClock(clock.utxos.at(0)).tokens).toBe(tokens - pr.slice);
      }),
      { numRuns: N },
    );
    report("clock: sell leg at the due height", N);
  });
});
