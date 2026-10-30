// Pure builders and quotes for ErgoDEX v1 ERG-to-token (N2T) pools: a direct swap against the pool box, no proxy
// order. The pool's own script checks the constant-product rule; the page only has to build a successor it accepts.
//   inputs:  0 pool (keyless), then the user's boxes
//   outputs: 0 pool successor (same tree, NFT and LP token, reserves moved, R4 copied), the user's output, the fee
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import { SConstant } from "@fleet-sdk/serializer";
import { hashOf, treeOf } from "../../registry.ts";
import { FEE } from "../machina/orders.ts";

/** Pool.sc `InitiallyLockedLP`: LP supply in circulation is this minus the LP tokens left in the pool box. */
export const INITIALLY_LOCKED_LP = 9_223_372_036_854_775_807n;

/** The N2T pool ErgoTree, identical for every pool (269 of 269 on mainnet on 2026-10-29; scripts/pools.ts lists them); src/registry.json. */
export const POOL_TREE = treeOf("ergodex-n2t-pool");
/** SHA-256 of its template, what the explorer's unspent search takes. */
export const POOL_TEMPLATE_SHA256 = hashOf("ergodex-n2t-pool");

export interface PoolView {
  boxId: string;
  nft: string;
  lpTokenId: string;
  /** LP tokens still in the pool box; circulating supply is INITIALLY_LOCKED_LP minus this */
  lpReserved: bigint;
  tokenId: string;
  /** ERG reserve, nanoERG */
  x: bigint;
  /** token reserve, smallest units */
  y: bigint;
  /** fee numerator over 1000 (997 = 0.3%) */
  feeNum: bigint;
}

export function describePool(box: Box<Amount>): PoolView {
  if (box.ergoTree !== POOL_TREE) throw new Error("not an N2T pool box");
  if (box.assets.length !== 3) throw new Error("pool box must hold NFT, LP token and the token");
  const r4 = box.additionalRegisters.R4;
  if (!r4) throw new Error("pool box has no R4");
  return {
    boxId: box.boxId,
    nft: box.assets[0].tokenId,
    lpTokenId: box.assets[1].tokenId,
    lpReserved: BigInt(box.assets[1].amount),
    tokenId: box.assets[2].tokenId,
    x: BigInt(box.value),
    y: BigInt(box.assets[2].amount),
    feeNum: BigInt(SConstant.from<number>(r4).data),
  };
}

export type SwapDirection = "erg-to-token" | "token-to-erg";

/** Tokens out for `dx` nanoERG in (floor), or nanoERG out for `dy` tokens in (floor). The pool's rule, rounded against the taker. */
export function quote(p: PoolView, dir: SwapDirection, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  if (dir === "erg-to-token") return (p.y * amountIn * p.feeNum) / (p.x * 1000n + amountIn * p.feeNum);
  return (p.x * amountIn * p.feeNum) / (p.y * 1000n + amountIn * p.feeNum);
}

/** The spot price before the trade and the effective price of this trade, as nanoERG per smallest unit times 1e9 (bigint ratio). */
export function priceImpactBps(p: PoolView, dir: SwapDirection, amountIn: bigint): bigint {
  const out = quote(p, dir, amountIn);
  if (out === 0n) return 0n;
  // spot: y per x, or x per y, scaled by the input amount, with the fee applied, minus the realised out
  const spotOut =
    dir === "erg-to-token" ? (p.y * amountIn * p.feeNum) / (p.x * 1000n) : (p.x * amountIn * p.feeNum) / (p.y * 1000n);
  if (spotOut === 0n) return 0n;
  return ((spotOut - out) * 10_000n) / spotOut;
}

/** The pool successor must hold strictly more than this (Pool.sc `MinStorageRent`, `validStorageRent`). */
export const POOL_MIN_VALUE = 10_000_000n;

export interface SwapParams {
  height: number;
  inputs: Box<Amount>[];
  user: ErgoAddress;
  poolBox: Box<Amount>;
  direction: SwapDirection;
  amountIn: bigint;
  /** refuse to build if the pool would pay less than this (slippage guard, computed by the caller from a quote) */
  minOut: bigint;
}

/** The largest Long: Pool.sc computes `deltaReservesX * feeNum0` in Long before widening, so an input past this over feeNum overflows the script. */
export const LONG_MAX = 9_223_372_036_854_775_807n;

export function buildSwap(p: SwapParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  if (p.amountIn * pool.feeNum > LONG_MAX)
    throw new Error(
      "the amount times the pool's fee numerator does not fit a Long: the pool script cannot evaluate it",
    );
  const out = quote(pool, p.direction, p.amountIn);
  if (out <= 0n) throw new Error("the trade is too small to receive anything");
  if (out < p.minOut) throw new Error(`the pool would pay ${out}, below the minimum ${p.minOut}`);
  const dx = p.direction === "erg-to-token" ? p.amountIn : -out;
  const dy = p.direction === "erg-to-token" ? -out : p.amountIn;
  if (pool.x + dx <= POOL_MIN_VALUE) throw new Error("the trade would take the pool to its minimum ERG or below");
  if (pool.y + dy <= 0n) throw new Error("the trade would empty the pool's token");

  const successor = new OutputBuilder(pool.x + dx, POOL_TREE)
    .addTokens([
      { tokenId: pool.nft, amount: 1n },
      { tokenId: pool.lpTokenId, amount: BigInt(p.poolBox.assets[1].amount) },
      { tokenId: pool.tokenId, amount: pool.y + dy },
    ])
    .setAdditionalRegisters({ R4: p.poolBox.additionalRegisters.R4 as string });

  const received =
    p.direction === "erg-to-token"
      ? new OutputBuilder(1_000_000n, p.user).addTokens({ tokenId: pool.tokenId, amount: out })
      : new OutputBuilder(out, p.user);

  return new TransactionBuilder(p.height)
    .from([p.poolBox, ...p.inputs])
    .to([successor, received])
    .sendChangeTo(p.user)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

// ---- liquidity ---------------------------------------------------------------------------------
// Pool.sc: a deposit may unlock at most min(dx * supply / x, dy * supply / y) LP tokens; a redemption of dLP must
// return at least dLP * x / supply ERG and dLP * y / supply tokens. Both rounded against the user here.

export function lpSupply(p: PoolView): bigint {
  return INITIALLY_LOCKED_LP - p.lpReserved;
}

/** Tokens that match `ergIn` at the pool's ratio (rounded up so the ERG side is the binding one), and the LP out. */
export function depositQuote(p: PoolView, ergIn: bigint): { tokenIn: bigint; lpOut: bigint } {
  if (ergIn <= 0n) return { tokenIn: 0n, lpOut: 0n };
  const tokenIn = (ergIn * p.y + p.x - 1n) / p.x;
  const supply = lpSupply(p);
  const lpOut = min((ergIn * supply) / p.x, (tokenIn * supply) / p.y);
  return { tokenIn, lpOut };
}

/** The other way round: the ERG that matches `tokenIn` at the pool's ratio (rounded up), and the LP out. */
export function depositQuoteFromTokens(p: PoolView, tokenIn: bigint): { ergIn: bigint; lpOut: bigint } {
  if (tokenIn <= 0n) return { ergIn: 0n, lpOut: 0n };
  const ergIn = (tokenIn * p.x + p.y - 1n) / p.y;
  const supply = lpSupply(p);
  const lpOut = min((ergIn * supply) / p.x, (tokenIn * supply) / p.y);
  return { ergIn, lpOut };
}

/** ERG and tokens returned for `lpIn` LP tokens, the pool's rule rounded down. */
export function redeemQuote(p: PoolView, lpIn: bigint): { ergOut: bigint; tokenOut: bigint } {
  if (lpIn <= 0n) return { ergOut: 0n, tokenOut: 0n };
  const supply = lpSupply(p);
  return { ergOut: (lpIn * p.x) / supply, tokenOut: (lpIn * p.y) / supply };
}

export interface DepositParams {
  height: number;
  inputs: Box<Amount>[];
  user: ErgoAddress;
  poolBox: Box<Amount>;
  ergIn: bigint;
}

export function buildDeposit(p: DepositParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  const { tokenIn, lpOut } = depositQuote(pool, p.ergIn);
  if (lpOut <= 0n) throw new Error("the deposit is too small to earn any LP token");
  const successor = new OutputBuilder(pool.x + p.ergIn, POOL_TREE)
    .addTokens([
      { tokenId: pool.nft, amount: 1n },
      { tokenId: pool.lpTokenId, amount: pool.lpReserved - lpOut },
      { tokenId: pool.tokenId, amount: pool.y + tokenIn },
    ])
    .setAdditionalRegisters({ R4: p.poolBox.additionalRegisters.R4 as string });
  const received = new OutputBuilder(1_000_000n, p.user).addTokens({ tokenId: pool.lpTokenId, amount: lpOut });
  return new TransactionBuilder(p.height)
    .from([p.poolBox, ...p.inputs])
    .to([successor, received])
    .sendChangeTo(p.user)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface RedeemParams {
  height: number;
  inputs: Box<Amount>[];
  user: ErgoAddress;
  poolBox: Box<Amount>;
  lpIn: bigint;
}

export function buildRedeem(p: RedeemParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  const { ergOut, tokenOut } = redeemQuote(pool, p.lpIn);
  if (ergOut <= 0n && tokenOut <= 0n) throw new Error("the redemption is too small to return anything");
  if (pool.x - ergOut <= POOL_MIN_VALUE)
    throw new Error("the redemption would take the pool to its minimum ERG or below");
  const successor = new OutputBuilder(pool.x - ergOut, POOL_TREE)
    .addTokens([
      { tokenId: pool.nft, amount: 1n },
      { tokenId: pool.lpTokenId, amount: pool.lpReserved + p.lpIn },
      { tokenId: pool.tokenId, amount: pool.y - tokenOut },
    ])
    .setAdditionalRegisters({ R4: p.poolBox.additionalRegisters.R4 as string });
  const received = new OutputBuilder(ergOut > 1_000_000n ? ergOut : 1_000_000n, p.user).addTokens({
    tokenId: pool.tokenId,
    amount: tokenOut,
  });
  return new TransactionBuilder(p.height)
    .from([p.poolBox, ...p.inputs])
    .to([successor, received])
    .sendChangeTo(p.user)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// ---- token-to-token pools (T2T) ----------------------------------------------------------------
// Same rules as N2T (Pool.sc, t2t): reserves are tokens 2 and 3, the box's ERG is a constant minimum that the
// successor must keep (preservedErgs). The deployed tree reads R4 as an Int (the repository's Pool.sc says Long;
// the chain disagrees, and the mock chain's evaluator showed it: `Cannot getReg[Int](4)` against a Long).

/** The T2T pool ErgoTree, identical for every pool (281 of 281 on mainnet on 2026-10-29; scripts/t2t-pools.ts lists them); src/registry.json. */
export const T2T_POOL_TREE = treeOf("ergodex-t2t-pool");
export const T2T_POOL_TEMPLATE_SHA256 = hashOf("ergodex-t2t-pool");

export interface T2TPoolView {
  boxId: string;
  nft: string;
  lpTokenId: string;
  lpReserved: bigint;
  xId: string;
  yId: string;
  x: bigint;
  y: bigint;
  feeNum: bigint;
  value: bigint;
}

export function describeT2TPool(box: Box<Amount>): T2TPoolView {
  if (box.ergoTree !== T2T_POOL_TREE) throw new Error("not a T2T pool box");
  if (box.assets.length !== 4) throw new Error("T2T pool box must hold NFT, LP token and two tokens");
  const r4 = box.additionalRegisters.R4;
  if (!r4) throw new Error("pool box has no R4");
  return {
    boxId: box.boxId,
    nft: box.assets[0].tokenId,
    lpTokenId: box.assets[1].tokenId,
    lpReserved: BigInt(box.assets[1].amount),
    xId: box.assets[2].tokenId,
    yId: box.assets[3].tokenId,
    x: BigInt(box.assets[2].amount),
    y: BigInt(box.assets[3].amount),
    feeNum: BigInt(SConstant.from<number | bigint>(r4).data),
    value: BigInt(box.value),
  };
}

/** A T2T pool seen from one side: pay `inId`, receive the other token. */
export function t2tSides(p: T2TPoolView, inId: string): { reserveIn: bigint; reserveOut: bigint; outId: string } {
  if (inId === p.xId) return { reserveIn: p.x, reserveOut: p.y, outId: p.yId };
  if (inId === p.yId) return { reserveIn: p.y, reserveOut: p.x, outId: p.xId };
  throw new Error("token is not in this pool");
}

export function quoteT2T(p: T2TPoolView, inId: string, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const { reserveIn, reserveOut } = t2tSides(p, inId);
  return (reserveOut * amountIn * p.feeNum) / (reserveIn * 1000n + amountIn * p.feeNum);
}

export function priceImpactBpsT2T(p: T2TPoolView, inId: string, amountIn: bigint): bigint {
  const out = quoteT2T(p, inId, amountIn);
  if (out === 0n) return 0n;
  const { reserveIn, reserveOut } = t2tSides(p, inId);
  const spotOut = (reserveOut * amountIn * p.feeNum) / (reserveIn * 1000n);
  return spotOut === 0n ? 0n : ((spotOut - out) * 10_000n) / spotOut;
}

function t2tSuccessor(p: T2TPoolView, box: Box<Amount>, x: bigint, y: bigint, lpReserved: bigint): OutputBuilder {
  return new OutputBuilder(p.value, T2T_POOL_TREE)
    .addTokens([
      { tokenId: p.nft, amount: 1n },
      { tokenId: p.lpTokenId, amount: lpReserved },
      { tokenId: p.xId, amount: x },
      { tokenId: p.yId, amount: y },
    ])
    .setAdditionalRegisters({ R4: box.additionalRegisters.R4 as string });
}

export interface SwapT2TParams {
  height: number;
  inputs: Box<Amount>[];
  user: ErgoAddress;
  poolBox: Box<Amount>;
  inId: string;
  amountIn: bigint;
  minOut: bigint;
}

export function buildSwapT2T(p: SwapT2TParams): EIP12UnsignedTransaction {
  const pool = describeT2TPool(p.poolBox);
  if (p.amountIn * pool.feeNum > LONG_MAX)
    throw new Error(
      "the amount times the pool's fee numerator does not fit a Long: the pool script cannot evaluate it",
    );
  const out = quoteT2T(pool, p.inId, p.amountIn);
  if (out <= 0n) throw new Error("the trade is too small to receive anything");
  if (out < p.minOut) throw new Error(`the pool would pay ${out}, below the minimum ${p.minOut}`);
  const { outId } = t2tSides(pool, p.inId);
  const inIsX = p.inId === pool.xId;
  const x1 = inIsX ? pool.x + p.amountIn : pool.x - out;
  const y1 = inIsX ? pool.y - out : pool.y + p.amountIn;
  if (x1 <= 0n || y1 <= 0n) throw new Error("the trade would empty the pool");
  const received = new OutputBuilder(1_000_000n, p.user).addTokens({ tokenId: outId, amount: out });
  return new TransactionBuilder(p.height)
    .from([p.poolBox, ...p.inputs])
    .to([t2tSuccessor(pool, p.poolBox, x1, y1, pool.lpReserved), received])
    .sendChangeTo(p.user)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export function lpSupplyT2T(p: T2TPoolView): bigint {
  return INITIALLY_LOCKED_LP - p.lpReserved;
}

/** Y that matches `xIn` at the pool's ratio (rounded up), and the LP out. */
export function depositQuoteT2T(p: T2TPoolView, xIn: bigint): { yIn: bigint; lpOut: bigint } {
  if (xIn <= 0n) return { yIn: 0n, lpOut: 0n };
  const yIn = (xIn * p.y + p.x - 1n) / p.x;
  const supply = lpSupplyT2T(p);
  return { yIn, lpOut: min((xIn * supply) / p.x, (yIn * supply) / p.y) };
}

export function depositQuoteT2TFromY(p: T2TPoolView, yIn: bigint): { xIn: bigint; lpOut: bigint } {
  if (yIn <= 0n) return { xIn: 0n, lpOut: 0n };
  const xIn = (yIn * p.x + p.y - 1n) / p.y;
  const supply = lpSupplyT2T(p);
  return { xIn, lpOut: min((xIn * supply) / p.x, (yIn * supply) / p.y) };
}

export function redeemQuoteT2T(p: T2TPoolView, lpIn: bigint): { xOut: bigint; yOut: bigint } {
  if (lpIn <= 0n) return { xOut: 0n, yOut: 0n };
  const supply = lpSupplyT2T(p);
  return { xOut: (lpIn * p.x) / supply, yOut: (lpIn * p.y) / supply };
}

export function buildDepositT2T(p: {
  height: number;
  inputs: Box<Amount>[];
  user: ErgoAddress;
  poolBox: Box<Amount>;
  xIn: bigint;
}): EIP12UnsignedTransaction {
  const pool = describeT2TPool(p.poolBox);
  const { yIn, lpOut } = depositQuoteT2T(pool, p.xIn);
  if (lpOut <= 0n) throw new Error("the deposit is too small to earn any LP token");
  const received = new OutputBuilder(1_000_000n, p.user).addTokens({ tokenId: pool.lpTokenId, amount: lpOut });
  return new TransactionBuilder(p.height)
    .from([p.poolBox, ...p.inputs])
    .to([t2tSuccessor(pool, p.poolBox, pool.x + p.xIn, pool.y + yIn, pool.lpReserved - lpOut), received])
    .sendChangeTo(p.user)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export function buildRedeemT2T(p: {
  height: number;
  inputs: Box<Amount>[];
  user: ErgoAddress;
  poolBox: Box<Amount>;
  lpIn: bigint;
}): EIP12UnsignedTransaction {
  const pool = describeT2TPool(p.poolBox);
  const { xOut, yOut } = redeemQuoteT2T(pool, p.lpIn);
  if (xOut <= 0n && yOut <= 0n) throw new Error("the redemption is too small to return anything");
  const received = new OutputBuilder(1_000_000n, p.user).addTokens([
    { tokenId: pool.xId, amount: xOut },
    { tokenId: pool.yId, amount: yOut },
  ]);
  return new TransactionBuilder(p.height)
    .from([p.poolBox, ...p.inputs])
    .to([t2tSuccessor(pool, p.poolBox, pool.x - xOut, pool.y - yOut, pool.lpReserved + p.lpIn), received])
    .sendChangeTo(p.user)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}
