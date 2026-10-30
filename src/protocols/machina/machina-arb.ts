// Machina limit orders priced across their token's ERG pool are keyless takes, like Babel bids: the order's own
// ERG (or tokens) funds the pool leg in the same transaction, and the gap is whoever builds it. The pool's
// successor must be output 0; the order plugin binds its own output by index.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import { LimitOrder } from "@nautls/machinafi-sdk";
import { POOL_TREE, describePool, quote, type PoolView } from "../ergodex/amm.ts";
import { FEE, asOrderBox, describe as describeOrder, type OrderView } from "./orders.ts";

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const bmin = (a: bigint, b: bigint) => (a < b ? a : b);

export interface OrderTake {
  t: bigint;
  /** nanoERG moved through the pool: paid in (order buys tokens) or taken out (order sells tokens) */
  poolErg: bigint;
  payout: bigint;
}

/**
 * Best take of an order against a pool, or undefined if none pays.
 * Order "sell" (takers sell tokens into it at `price`): buy t from the pool for dx = ceil(t*x0*1000/(fee*(y0-t))),
 * the order pays t*price. Order "buy" (takers buy tokens at `price`): buy t from the order for t*price, the pool pays
 * floor(x0*t*fee/(y0*1000 + t*fee)). Both concave in t.
 */
export function sizeOrderTake(pool: PoolView, order: OrderView, fee = FEE): OrderTake | undefined {
  if (pool.tokenId !== order.tokenId) throw new Error("the pool's token is not the order's token");
  const intoOrder = order.takerAction === "sell";
  // into an order: leave it at least 0.0001 ERG so its remainder (partial recreation, or the full-fill payout to
  // the owner) still covers a box's minimum value, which the SDK checks
  const hiCap = intoOrder ? bmin((order.value - 100_000n) / order.price, pool.y - 1n) : order.tokenAmount;
  if (hiCap < 1n || order.price <= 0n) return undefined;
  const poolLeg = (t: bigint) =>
    intoOrder ? ceilDiv(t * pool.x * 1000n, pool.feeNum * (pool.y - t)) : quote(pool, "token-to-erg", t);
  const profit = (t: bigint) => (intoOrder ? t * order.price - poolLeg(t) : poolLeg(t) - t * order.price);
  let lo = 1n,
    hi = hiCap;
  while (hi - lo > 4n) {
    const m1 = lo + (hi - lo) / 3n,
      m2 = hi - (hi - lo) / 3n;
    if (profit(m1) < profit(m2)) lo = m1 + 1n;
    else hi = m2 - 1n;
  }
  let best = 0n,
    bestProfit = -1n;
  for (let k = lo - 4n > 1n ? lo - 4n : 1n; k <= hi + 4n && k <= hiCap; k++) {
    const p = profit(k);
    if (p > bestProfit) [best, bestProfit] = [k, p];
  }
  if (best === 0n) return undefined;
  const payout = profit(best) - fee;
  if (payout <= 0n) return undefined;
  return { t: best, poolErg: poolLeg(best), payout };
}

export interface OrderTakeParams {
  height: number;
  poolBox: Box<Amount>;
  orderBox: Box<Amount>;
  payTo: ErgoAddress;
}

export function buildOrderTake(
  p: OrderTakeParams,
): { tx: EIP12UnsignedTransaction; take: OrderTake; order: OrderView } | undefined {
  const pool = describePool(p.poolBox);
  const order = describeOrder(p.orderBox);
  const take = sizeOrderTake(pool, order);
  if (!take) return undefined;
  const intoOrder = order.takerAction === "sell";
  const poolOut = new OutputBuilder(intoOrder ? pool.x + take.poolErg : pool.x - take.poolErg, POOL_TREE)
    .addTokens([
      { tokenId: pool.nft, amount: 1n },
      { tokenId: pool.lpTokenId, amount: BigInt(p.poolBox.assets[1].amount) },
      { tokenId: pool.tokenId, amount: intoOrder ? pool.y - take.t : pool.y + take.t },
    ])
    .setAdditionalRegisters({ R4: p.poolBox.additionalRegisters.R4 as string });
  const lo = new LimitOrder(asOrderBox(p.orderBox));
  const action = intoOrder ? lo.sell(take.t) : lo.buy(take.t);
  const tx = new TransactionBuilder(p.height)
    .from([p.poolBox])
    .to(poolOut)
    .extend(action)
    .to(new OutputBuilder(take.payout, p.payTo))
    .payFee(FEE)
    .build()
    .toEIP12Object();
  return { tx, take, order };
}
