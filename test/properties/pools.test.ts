// Pool quotes against the pool's own rule, with the mock chain as the oracle where a transaction is involved.
import { MockChain } from "@fleet-sdk/mock-chain";
import { describe, expect, it } from "vitest";
import { SInt } from "@fleet-sdk/serializer";
import fc from "fast-check";
import {
  POOL_MIN_VALUE,
  POOL_TREE,
  T2T_POOL_TREE,
  buildDeposit,
  buildSwap,
  buildSwapT2T,
  depositQuote,
  depositQuoteFromTokens,
  depositQuoteT2T,
  depositQuoteT2TFromY,
  describePool,
  describeT2TPool,
  quote,
  quoteT2T,
  redeemQuote,
  type PoolView,
  type T2TPoolView,
} from "../../src/protocols/ergodex/amm";
import { LONG_MAX, big, feeNum, report, reserve, TWO_62 } from "./setup";

const NFT = "11".repeat(32),
  LP = "22".repeat(32),
  TOKEN = "33".repeat(32),
  TOKEN2 = "44".repeat(32);
const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_775_807n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

const view = (x: bigint, y: bigint, fee: bigint): PoolView => ({
  boxId: "00".repeat(32),
  nft: NFT,
  lpTokenId: LP,
  lpReserved: LP_MAX - 1_000_000n,
  tokenId: TOKEN,
  x,
  y,
  feeNum: fee,
});
const t2tView = (x: bigint, y: bigint, fee: bigint): T2TPoolView => ({
  boxId: "00".repeat(32),
  nft: NFT,
  lpTokenId: LP,
  lpReserved: LP_MAX - 1_000_000n,
  xId: TOKEN,
  yId: TOKEN2,
  x,
  y,
  feeNum: fee,
  value: 10_000_000n,
});

/** A pool and an amount to pay in: the ERG side above the pool's minimum, the sum of a reserve and the amount within a Long. */
const poolAndAmount = fc
  .record({ x: big(POOL_MIN_VALUE + 1n, TWO_62 - 1n), y: reserve, fee: feeNum, dir: fc.boolean(), r: big(1n, TWO_62) })
  .map(({ x, y, fee, dir, r }) => {
    const direction = dir ? ("erg-to-token" as const) : ("token-to-erg" as const);
    const reserveIn = direction === "erg-to-token" ? x : y;
    const amountIn = 1n + (r % reserveIn); // 1 to the reserve
    return { p: view(x, y, fee), direction, amountIn };
  });

describe("a pool quote is the pool's rule, rounded against the taker", () => {
  it("out * (reserveIn * 1000 + in * fee) <= reserveOut * in * fee, and one more unit would break it (N2T, both directions)", () => {
    const N = 2000;
    fc.assert(
      fc.property(poolAndAmount, ({ p, direction, amountIn }) => {
        const out = quote(p, direction, amountIn);
        const [reserveIn, reserveOut] = direction === "erg-to-token" ? [p.x, p.y] : [p.y, p.x];
        const denom = reserveIn * 1000n + amountIn * p.feeNum;
        // Pool.sc: reservesY * deltaX * feeNum >= deltaY * (reservesX * 1000 + deltaX * feeNum), the same inequality in each direction
        expect(out * denom <= reserveOut * amountIn * p.feeNum).toBe(true);
        expect((out + 1n) * denom > reserveOut * amountIn * p.feeNum).toBe(true);
        expect(out < reserveOut).toBe(true);
      }),
      { numRuns: N },
    );
    report("pools: quote bound N2T", N);
  });
  it("the same for a token-to-token pool, either side paid", () => {
    const N = 2000;
    fc.assert(
      fc.property(fc.record({ x: reserve, y: reserve, fee: feeNum, inX: fc.boolean(), r: big(1n, TWO_62) }), (c) => {
        const p = t2tView(c.x, c.y, c.fee);
        const inId = c.inX ? p.xId : p.yId;
        const [reserveIn, reserveOut] = c.inX ? [p.x, p.y] : [p.y, p.x];
        const amountIn = 1n + (c.r % reserveIn);
        const out = quoteT2T(p, inId, amountIn);
        const denom = reserveIn * 1000n + amountIn * p.feeNum;
        expect(out * denom <= reserveOut * amountIn * p.feeNum).toBe(true);
        expect((out + 1n) * denom > reserveOut * amountIn * p.feeNum).toBe(true);
      }),
      { numRuns: N },
    );
    report("pools: quote bound T2T", N);
  });
});

describe("a swap built at the quote executes on the mock chain, and minOut one above the quote is refused by the builder", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const user = chain.newParty("user");
  const pool = chain.addParty(POOL_TREE, "pool");
  /** Pools the chain can hold: the sum of a reserve and the amount within a Long, and an output box big enough to exist. */
  const chainCase = fc
    .record({
      x: big(POOL_MIN_VALUE + 1n, TWO_62 - 1n),
      y: big(2n, TWO_62),
      fee: feeNum,
      dir: fc.boolean(),
      r: big(1n, TWO_62),
    })
    .map(({ x, y, fee, dir, r }) => {
      const direction = dir ? ("erg-to-token" as const) : ("token-to-erg" as const);
      const reserveIn = direction === "erg-to-token" ? x : y;
      const amountIn = 1n + (r % reserveIn);
      return { x, y, fee, direction, amountIn };
    })
    .map((c) => ({ ...c, amountIn: 1n + ((c.amountIn - 1n) % (LONG_MAX / c.fee)) })) // what Pool.sc can multiply by feeNum in Long
    .filter(({ x, y, fee, direction, amountIn }) => {
      const out = quote(view(x, y, fee), direction, amountIn);
      // the taker's output must be a box the node accepts (0.001 ERG) and must not empty the pool past its minimum
      if (direction === "erg-to-token") return out > 0n && y - out > 0n;
      return out >= 1_000_000n && x - out > POOL_MIN_VALUE;
    });

  it("an input the pool script cannot multiply by its fee numerator in a Long is refused by the builder, not the node", () => {
    // found by this suite on 2026-10-29: Pool.sc's validSwap computes deltaReservesX * feeNum0 in Long before widening
    // to BigInt, so sigmastate-js threw "long overflow" on an input above LONG_MAX / feeNum; the builder now refuses it
    const N = 200;
    fc.assert(
      fc.property(
        fc.record({ x: big(POOL_MIN_VALUE + 1n, TWO_62), y: big(2n, TWO_62), fee: feeNum, r: big(0n, TWO_62) }),
        ({ x, y, fee, r }) => {
          const amountIn = LONG_MAX / fee + 1n + (r % (TWO_62 - LONG_MAX / fee));
          const poolBox = {
            boxId: "00".repeat(32),
            transactionId: "00".repeat(32),
            index: 0,
            value: x,
            ergoTree: POOL_TREE,
            creationHeight: 1,
            assets: [
              { tokenId: NFT, amount: 1n },
              { tokenId: LP, amount: LP_MAX - 1_000_000n },
              { tokenId: TOKEN, amount: y },
            ],
            additionalRegisters: { R4: SInt(Number(fee)).toHex() },
          };
          const inputs = [
            {
              ...poolBox,
              boxId: "01".repeat(32),
              ergoTree: user.address.ergoTree,
              value: amountIn + ERG,
              assets: [],
              additionalRegisters: {},
            },
          ];
          expect(() =>
            buildSwap({
              height: 1,
              inputs,
              user: user.address,
              poolBox,
              direction: "erg-to-token",
              amountIn,
              minOut: 0n,
            }),
          ).toThrow(/does not fit a Long/);
        },
      ),
      { numRuns: N },
    );
    report("pools: Long overflow guard", N);
  });

  it("N2T, both directions", () => {
    const N = 40;
    fc.assert(
      fc.property(chainCase, ({ x, y, fee, direction, amountIn }) => {
        chain.reset({ clearParties: true });
        pool.addBalance(
          {
            nanoergs: x,
            tokens: [
              { tokenId: NFT, amount: 1n },
              { tokenId: LP, amount: LP_MAX - 1_000_000n },
              { tokenId: TOKEN, amount: y },
            ],
          },
          { R4: SInt(Number(fee)).toHex() },
        );
        user.addBalance(
          direction === "erg-to-token"
            ? { nanoergs: amountIn + 1n * ERG }
            : { nanoergs: 1n * ERG, tokens: [{ tokenId: TOKEN, amount: amountIn }] },
        );
        chain.addParty(user);
        chain.addParty(pool);
        const p = describePool(pool.utxos.at(0));
        const out = quote(p, direction, amountIn);
        const params = {
          height: chain.height,
          inputs: user.utxos.toArray(),
          user: user.address,
          poolBox: pool.utxos.at(0),
          direction,
          amountIn,
        };
        expect(() => buildSwap({ ...params, minOut: out + 1n })).toThrow(/below the minimum/);
        const tx = buildSwap({ ...params, minOut: out });
        expect(chain.execute(tx, { signers: [user] })).toBe(true);
        const after = describePool(pool.utxos.at(0));
        if (direction === "erg-to-token") {
          expect(after.x).toBe(x + amountIn);
          expect(after.y).toBe(y - out);
          expect(user.balance.tokens).toEqual([{ tokenId: TOKEN, amount: out }]);
        } else {
          expect(after.x).toBe(x - out);
          expect(after.y).toBe(y + amountIn);
          expect(user.balance.tokens).toEqual([]);
        }
      }),
      { numRuns: N },
    );
    report("pools: swap executes N2T", N);
  });

  const t2t = chain.addParty(T2T_POOL_TREE, "t2t");
  const t2tCase = fc
    .record({ x: big(2n, TWO_62), y: big(2n, TWO_62), fee: feeNum, inX: fc.boolean(), r: big(1n, TWO_62) })
    .map(({ x, y, fee, inX, r }) => ({ x, y, fee, inX, amountIn: 1n + (r % (inX ? x : y)) }))
    .map((c) => ({ ...c, amountIn: 1n + ((c.amountIn - 1n) % (LONG_MAX / c.fee)) }))
    .filter(({ x, y, fee, inX, amountIn }) => {
      const p = t2tView(x, y, fee);
      const out = quoteT2T(p, inX ? p.xId : p.yId, amountIn);
      return out > 0n && (inX ? y - out > 0n : x - out > 0n);
    });
  it("T2T, either side paid", () => {
    const N = 40;
    fc.assert(
      fc.property(t2tCase, ({ x, y, fee, inX, amountIn }) => {
        chain.reset({ clearParties: true });
        t2t.addBalance(
          {
            nanoergs: 10_000_000n,
            tokens: [
              { tokenId: NFT, amount: 1n },
              { tokenId: LP, amount: LP_MAX - 1_000_000n },
              { tokenId: TOKEN, amount: x },
              { tokenId: TOKEN2, amount: y },
            ],
          },
          { R4: SInt(Number(fee)).toHex() },
        );
        const inId = inX ? TOKEN : TOKEN2;
        user.addBalance({ nanoergs: 1n * ERG, tokens: [{ tokenId: inId, amount: amountIn }] });
        chain.addParty(user);
        chain.addParty(t2t);
        const p = describeT2TPool(t2t.utxos.at(0));
        const out = quoteT2T(p, inId, amountIn);
        const params = {
          height: chain.height,
          inputs: user.utxos.toArray(),
          user: user.address,
          poolBox: t2t.utxos.at(0),
          inId,
          amountIn,
        };
        expect(() => buildSwapT2T({ ...params, minOut: out + 1n })).toThrow(/below the minimum/);
        expect(chain.execute(buildSwapT2T({ ...params, minOut: out }), { signers: [user] })).toBe(true);
        const after = describeT2TPool(t2t.utxos.at(0));
        expect(inX ? after.x : after.y).toBe((inX ? x : y) + amountIn);
        expect(inX ? after.y : after.x).toBe((inX ? y : x) - out);
      }),
      { numRuns: N },
    );
    report("pools: swap executes T2T", N);
  });
});

describe("the ERG-first and tokens-first deposit quotes agree", () => {
  // depositQuote rounds the token side up: tokenIn = ceil(ergIn * y / x); depositQuoteFromTokens rounds the ERG side
  // up: ergIn' = ceil(tokenIn * x / y). So ergIn <= ergIn' < ergIn + x / y + 1 (one unit of the other side's rounding),
  // the LP out never falls, and asking ERG-first again for ergIn' lands on the same token amount or within one unit.
  const poolCase = fc.record({ x: big(POOL_MIN_VALUE + 1n, TWO_62), y: reserve, fee: feeNum, r: big(1n, TWO_62) });
  it("N2T: tokens-first on the tokens ERG-first asked for gives the same point of the ratio within one rounding step", () => {
    const N = 2000;
    fc.assert(
      fc.property(poolCase, ({ x, y, fee, r }) => {
        const p = view(x, y, fee);
        const ergIn = 1n + (r % x);
        const a = depositQuote(p, ergIn);
        expect(a.tokenIn).toBe(ceilDiv(ergIn * y, x));
        const b = depositQuoteFromTokens(p, a.tokenIn);
        expect(b.ergIn >= ergIn).toBe(true);
        expect(b.ergIn <= ergIn + ceilDiv(x, y)).toBe(true);
        expect(b.lpOut >= a.lpOut).toBe(true);
        const c = depositQuote(p, b.ergIn);
        expect(c.tokenIn >= a.tokenIn && c.tokenIn <= a.tokenIn + ceilDiv(y, x)).toBe(true);
        // both quotes are the pool's own LP rule: min(dx * supply / x, dy * supply / y), floored
        const supply = LP_MAX - p.lpReserved;
        const min = (u: bigint, v: bigint) => (u < v ? u : v);
        expect(a.lpOut).toBe(min((ergIn * supply) / x, (a.tokenIn * supply) / y));
        expect(b.lpOut).toBe(min((b.ergIn * supply) / x, (a.tokenIn * supply) / y));
      }),
      { numRuns: N },
    );
    report("pools: deposit quotes agree N2T", N);
  });
  it("T2T: the same from either token", () => {
    const N = 2000;
    fc.assert(
      fc.property(fc.record({ x: reserve, y: reserve, fee: feeNum, r: big(1n, TWO_62) }), ({ x, y, fee, r }) => {
        const p = t2tView(x, y, fee);
        const xIn = 1n + (r % x);
        const a = depositQuoteT2T(p, xIn);
        expect(a.yIn).toBe(ceilDiv(xIn * y, x));
        const b = depositQuoteT2TFromY(p, a.yIn);
        expect(b.xIn >= xIn && b.xIn <= xIn + ceilDiv(x, y)).toBe(true);
        expect(b.lpOut >= a.lpOut).toBe(true);
      }),
      { numRuns: N },
    );
    report("pools: deposit quotes agree T2T", N);
  });

  const chain = new MockChain({ height: 1_900_000 });
  const user = chain.newParty("user");
  const pool = chain.addParty(POOL_TREE, "pool");
  it("on the mock chain, a deposit built from either side executes and the redeem quote returns no more than the share", () => {
    const N = 30;
    // realistic depths: pools of 0.01 to 4,000,000 ERG with tokens up to 2^62 units; the deposit a fraction of the pool
    const c = fc
      .record({
        x: big(10n * POOL_MIN_VALUE, 4_000_000n * ERG),
        y: big(1000n, TWO_62),
        fee: feeNum,
        r: big(1n, TWO_62),
      })
      .map(({ x, y, fee, r }) => ({ x, y, fee, ergIn: 1_000_000n + (r % (x / 2n)) }))
      .filter(({ x, y, fee, ergIn }) => depositQuote(view(x, y, fee), ergIn).lpOut > 0n);
    fc.assert(
      fc.property(c, ({ x, y, fee, ergIn }) => {
        for (const side of ["erg", "tokens"] as const) {
          chain.reset({ clearParties: true });
          pool.addBalance(
            {
              nanoergs: x,
              tokens: [
                { tokenId: NFT, amount: 1n },
                { tokenId: LP, amount: LP_MAX - 1_000_000n },
                { tokenId: TOKEN, amount: y },
              ],
            },
            { R4: SInt(Number(fee)).toHex() },
          );
          const p = view(x, y, fee);
          const a = depositQuote(p, ergIn);
          const pay = side === "erg" ? ergIn : depositQuoteFromTokens(p, a.tokenIn).ergIn;
          const tokens = depositQuote(p, pay).tokenIn;
          user.addBalance({ nanoergs: pay + 1n * ERG, tokens: [{ tokenId: TOKEN, amount: tokens }] });
          chain.addParty(user);
          chain.addParty(pool);
          const tx = buildDeposit({
            height: chain.height,
            inputs: user.utxos.toArray(),
            user: user.address,
            poolBox: pool.utxos.at(0),
            ergIn: pay,
          });
          expect(chain.execute(tx, { signers: [user] })).toBe(true);
          const lp = user.balance.tokens.find((t) => t.tokenId === LP)!.amount;
          expect(lp).toBe(depositQuote(p, pay).lpOut);
          const after = describePool(pool.utxos.at(0));
          const q = redeemQuote(after, lp);
          const supply = LP_MAX - after.lpReserved;
          expect(q.ergOut * supply <= lp * after.x && q.tokenOut * supply <= lp * after.y).toBe(true);
        }
      }),
      { numRuns: N },
    );
    report("pools: deposit executes from either side", N);
  });
});
