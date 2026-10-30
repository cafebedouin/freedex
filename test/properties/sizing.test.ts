// The keyless take sizing (a ternary search over a concave profit, then a scan of the neighbourhood) never pays
// below the brute-force maximum, on pools small enough to enumerate every take.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PoolView } from "../../src/protocols/ergodex/amm";
import { BABEL_KEEP, sizeBabelTake, type BabelView } from "../../src/protocols/babel/babel";
import { sizeOrderTake } from "../../src/protocols/machina/machina-arb";
import { FEE, type OrderView } from "../../src/protocols/machina/orders";
import { big, feeNum, report } from "./setup";

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const bmin = (a: bigint, b: bigint) => (a < b ? a : b);
const pool = (x: bigint, y: bigint, fee: bigint): PoolView => ({
  boxId: "",
  nft: "",
  lpTokenId: "",
  lpReserved: 0n,
  tokenId: "t",
  x,
  y,
  feeNum: fee,
});
/** Pools with at most 3,000 token units, so every take can be tried; ERG side 0.1 to 1,000 ERG. */
const smallPool = fc.record({ x: big(100_000_000n, 1_000_000_000_000n), y: big(2n, 3000n), fee: feeNum });

describe("Babel take sizing equals the brute-force optimum", () => {
  it("for any bid and box value, the payout is the best over every t in 1 .. y - 1, or undefined when none pays", () => {
    const N = 300;
    const c = smallPool.chain((p) =>
      fc.record({
        p: fc.constant(p),
        // bids from a tenth of the pool price to five times it, so both sides of "nothing pays" are drawn
        bid: big(1n, (10n * p.x) / p.y + 1n).map((b) => (b * 5n) / 10n + 1n),
        value: big(BABEL_KEEP - 1n, 100n * 1_000_000_000n),
      }),
    );
    fc.assert(
      fc.property(c, ({ p, bid, value }) => {
        const pv = pool(p.x, p.y, p.fee);
        const b: BabelView = { boxId: "", tokenId: "t", bid, value, tokens: 0n, owner: "" };
        const got = sizeBabelTake(pv, b);
        const cap = value - BABEL_KEEP;
        let best = -1n;
        for (let t = 1n; t < p.y; t++) {
          const cost = ceilDiv(t * p.x * 1000n, p.fee * (p.y - t));
          const profit = bmin(t * bid, cap) - cost - FEE;
          if (profit > best) best = profit;
        }
        if (best <= 0n || cap <= 0n) expect(got).toBeUndefined();
        else {
          expect(got).toBeDefined();
          expect(got!.payout).toBe(best);
          expect(got!.y - got!.dx - FEE).toBe(got!.payout);
          expect(got!.y <= cap && got!.y <= got!.t * bid).toBe(true);
        }
      }),
      { numRuns: N },
    );
    report("sizing: Babel equals brute force", N);
  });
});

describe("Machina order take sizing equals the brute-force optimum", () => {
  it("an order takers sell into (the pool leg buys t, the order pays t * price)", () => {
    const N = 300;
    const c = smallPool.chain((p) =>
      fc.record({
        p: fc.constant(p),
        price: big(1n, (10n * p.x) / p.y + 1n).map((b) => (b * 5n) / 10n + 1n),
        value: big(100_000n, 100n * 1_000_000_000n),
      }),
    );
    fc.assert(
      fc.property(c, ({ p, price, value }) => {
        const pv = pool(p.x, p.y, p.fee);
        const o: OrderView = {
          boxId: "",
          takerAction: "sell",
          price,
          tokenId: "t",
          tokenAmount: 0n,
          value,
          owner: "",
          creationHeight: 0,
        };
        const got = sizeOrderTake(pv, o);
        let best = -1n;
        for (let t = 1n; t <= (value - 100_000n) / price && t < p.y; t++) {
          const profit = t * price - ceilDiv(t * p.x * 1000n, p.fee * (p.y - t)) - FEE;
          if (profit > best) best = profit;
        }
        if (best <= 0n) expect(got).toBeUndefined();
        else expect(got!.payout).toBe(best);
      }),
      { numRuns: N },
    );
    report("sizing: Machina into-order equals brute force", N);
  });
  it("an order takers buy from (the order sells t at price, the pool leg pays the rule)", () => {
    const N = 300;
    const c = smallPool.chain((p) =>
      fc.record({
        p: fc.constant(p),
        price: big(1n, (10n * p.x) / p.y + 1n).map((b) => (b * 5n) / 10n + 1n),
        tokenAmount: big(1n, 3000n),
      }),
    );
    fc.assert(
      fc.property(c, ({ p, price, tokenAmount }) => {
        const pv = pool(p.x, p.y, p.fee);
        const o: OrderView = {
          boxId: "",
          takerAction: "buy",
          price,
          tokenId: "t",
          tokenAmount,
          value: 1_000_000n,
          owner: "",
          creationHeight: 0,
        };
        const got = sizeOrderTake(pv, o);
        let best = -1n;
        for (let t = 1n; t <= tokenAmount; t++) {
          const out = (p.x * t * p.fee) / (p.y * 1000n + t * p.fee);
          const profit = out - t * price - FEE;
          if (profit > best) best = profit;
        }
        if (best <= 0n) expect(got).toBeUndefined();
        else expect(got!.payout).toBe(best);
      }),
      { numRuns: N },
    );
    report("sizing: Machina from-order equals brute force", N);
  });
});
