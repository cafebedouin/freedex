// The ternary searches in babel.ts and machina-arb.ts against a brute-force maximum on small pools.
import { describe, expect, it } from "vitest";
import type { PoolView } from "../src/amm";
import { sizeBabelTake, type BabelView } from "../src/babel";
import { sizeOrderTake } from "../src/machina-arb";
import { FEE, type OrderView } from "../src/orders";

const pool = (x: bigint, y: bigint, feeNum = 997n): PoolView => ({
  boxId: "",
  nft: "",
  lpTokenId: "",
  lpReserved: 0n,
  tokenId: "t",
  x,
  y,
  feeNum,
});
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

describe("take sizing equals the brute-force optimum", () => {
  it("Babel", () => {
    for (const [x, y, bid, value] of [
      [1_000_000_000n, 50_000n, 30_000n, 100_000_000n],
      [5_000_000_000n, 300n, 40_000_000n, 2_000_000_000n],
      [777_777_777n, 1_234n, 900_000n, 50_000_000n],
    ] as const) {
      const p = pool(x, y);
      const b: BabelView = { boxId: "", tokenId: "t", bid, value, tokens: 0n, owner: "" };
      const got = sizeBabelTake(p, b);
      let best = -1n;
      for (let t = 1n; t < y; t++) {
        const cost = ceilDiv(t * x * 1000n, p.feeNum * (y - t));
        const pay = t * bid < value - 1_000_000n ? t * bid : value - 1_000_000n;
        const profit = pay - cost - FEE;
        if (profit > best) best = profit;
      }
      if (best <= 0n) expect(got).toBeUndefined();
      else expect(got!.payout).toBe(best);
    }
  });
  it("Machina, both sides", () => {
    const p = pool(1_000_000_000n, 50_000n);
    const into: OrderView = {
      boxId: "",
      takerAction: "sell",
      price: 30_000n,
      tokenId: "t",
      tokenAmount: 0n,
      value: 100_000_000n,
      owner: "",
      creationHeight: 0,
    };
    const got = sizeOrderTake(p, into)!;
    let best = -1n;
    for (let t = 1n; t <= (into.value - 100_000n) / into.price && t < p.y; t++) {
      const profit = t * into.price - ceilDiv(t * p.x * 1000n, p.feeNum * (p.y - t)) - FEE;
      if (profit > best) best = profit;
    }
    expect(got.payout).toBe(best);
    const from: OrderView = {
      boxId: "",
      takerAction: "buy",
      price: 15_000n,
      tokenId: "t",
      tokenAmount: 3_000n,
      value: 1_000_000n,
      owner: "",
      creationHeight: 0,
    };
    const got2 = sizeOrderTake(p, from)!;
    best = -1n;
    for (let t = 1n; t <= from.tokenAmount; t++) {
      const out = (p.x * t * p.feeNum) / (p.y * 1000n + t * p.feeNum);
      const profit = out - t * from.price - FEE;
      if (profit > best) best = profit;
    }
    expect(got2.payout).toBe(best);
  });
});
