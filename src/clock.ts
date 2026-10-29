// The clocked box (contracts/Clock.es and ClockSell.es, skunkyard SK-064): a box anyone may act on once per
// interval against one ErgoDEX v1 ERG pool for its owner, a bounded fee to whoever builds the leg. The buy side
// holds ERG and buys one slice of tokens per leg (dollar-cost averaging, a rate limit); the sell side holds tokens
// and sells one slice per leg (the tranche sale). Pure builders, no DOM, no network.
//   create: the owner funds the box. Buy: legs x (slice + executorFee), no rent reserve (the box is ERG: a
//           storage-rent claim on an abandoned box takes its fee from the budget and leaves a smaller program).
//           Sell: the tokens, legs x executorFee, one full storage-rent fee held back and returned with the last
//           leg (a token box too small to pay rent is consumed whole, tokens included), and the node's minimum.
//   leg:    keyless; inputs 0 pool, 1 clock; outputs 0 pool successor, 1 the owner's output, 2 the successor
//           (not on the last leg), then the executor's payout and the miner fee, which both come out of executorFee
//   cancel: the owner's key, everything back, any time
// The box's creation height is its clock. Both the create and the leg builders set it to the build height plus
// one, the height the box can first be mined at, so the first leg is due an interval after inclusion, not before.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, ErgoUnsignedInput, OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import {
  SByte,
  SColl,
  SConstant,
  SGroupElement,
  SInt,
  SLong,
  SSigmaProp,
  estimateBoxSize,
} from "@fleet-sdk/serializer";
import { POOL_MIN_VALUE, POOL_TREE, describePool, quote, type PoolView } from "./amm.ts";
import { FEE } from "./orders.ts";

/** contracts/Clock.es compiled by scripts/compile-clock.ts (ErgoTree v1, segregated constants, SLACK 4); pinned by test/hashes.test.ts. */
export const CLOCK_TREE =
  "19f50313040204000406040804000404040a040004020400050006022710060203e805a09c0104040500040004080100d809d601e4c6a70408d602e30004d603e4c6a70711d604b27203730000d605e4c6a7060ed606e4c6a7050ed607b27203730100d608b27203730200d609b27203730300eb027201d195e67202d80dd60a8cc7a701d60bc2a7d60cb2a4730400d60ddb6308720cd60eb2720d730500d60fc1a7d6108f999999720fb27203730600720772089a72077208d611957210a1720799720f72087207d612b2a5e4720200d613b2db63087212730700d6147e8c72130206d6157e721106d6167ee4c6720c04040696830901927e99a3720a05720493b1b5a4d901176393c27217720b7308938cb2720d730900017205938c720e017206917211730a929c7214730b9c9d9c9c7e8c720e0206721572169a9c7ec1720c06730c9c721572167e99730db27203730e0006ec937209730f9072159c7e72090672149683030193c27212d0720193e4c67212040ec5a7938c721301720695721092c172129999720f72117208d802d617b2a5e4e3010400d6188cc77217019683090193c27217720b92c172179999720f7207720893b1db63087217731093e4c672170408720193e4c67217050e720693e4c67217060e720593e4c672170711720392721899a37311927e7218059a7e720a0572047312";
/** SHA-256 of the template, what the explorer's unspent search takes. */
export const CLOCK_TEMPLATE_SHA256 = "a1df056602fa8628c9169bbf947ec7121ea123b1e03b4b6f73de54712f5f7e7e";
/** contracts/ClockSell.es, compiled the same way. */
export const CLOCK_SELL_TREE =
  "198204150402040004060408040004040400050004020400050006022710060203e805a09c010404050001010400040204080100d809d601e4c6a70408d602e30004d603e4c6a70711d604b27203730000d605e4c6a7060ed606e4c6a7050ed607b27203730100d608b27203730200d609b27203730300eb027201d195e67202d80ed60a8cc7a701d60bc2a7d60cb2a4730400d60ddb6308720cd60eb2720d730500d60fb2db6308a7730600d6108c720f02d6119972107207d6128f72117207d61395721272107207d614b2a5e4720200d6157e99c1721495721299c1a77208730706d6167e721306d6177ee4c6720c04040696830a01927e99a3720a05720493b1b5a4d901186393c27218720b7308938cb2720d730900017205938c720e017206938c720f017206917213730a929c7215730b9c9d9c9c7ec1720c06721672179a9c7e8c720e0206730c9c721672177e99730db27203730e0006ec937209730f9272159c7e72090672169683020193c27214d0720193e4c67214040ec5a79572127310d804d618b2a5e4e3010400d619db63087218d61ab27219731100d61b8cc772180196830b0193c27218720b92c1721899c1a7720893b172197312938c721a017206928c721a02721193e4c672180408720193e4c67218050e720693e4c67218060e720593e4c672180711720392721b99a37313927e721b059a7e720a0572047314";
export const CLOCK_SELL_TEMPLATE_SHA256 = "7bf4e2d6ba91f9d1c1dfc7ff2caa89e9896f1c9fad8e6dd19d8aeeda7e163e39";
/** Blocks an executor may backdate a successor; also how long a built leg stays valid (SLACK in both contracts). */
export const CLOCK_SLACK = 4;
/** One storage-rent period, blocks; a program whose legs x interval passes it is refused at creation. */
export const RENT_PERIOD = 1_051_200;
/** Mainnet storage fee per byte per period, nanoERG (networkState.params.storageFeeFactor, 2026-10-29). */
export const STORAGE_FEE_FACTOR = 1_250_000n;
/** The node's minimum box value per byte, nanoERG (minValuePerByte). */
export const MIN_VALUE_PER_BYTE = 360n;
/** ERG the owner's output carries at least on a leg that is not the last; any shortfall comes out of the executor's fee. */
export const OWNER_BOX_VALUE = 100_000n;
/** Mainnet blocks per day, for showing an interval. */
export const BLOCKS_PER_DAY = 720;

export type ClockSide = "buy" | "sell";

export interface ClockView {
  side: ClockSide;
  boxId: string;
  owner: string;
  tokenId: string;
  poolNft: string;
  /** buy: nanoERG per leg; sell: token units per leg */
  slice: bigint;
  interval: bigint;
  toleranceBps: bigint;
  executorFee: bigint;
  /** buy side: nanoERG per smallest unit above which a leg waits; 0 for no cap (always 0 on the sell side) */
  maxPrice: bigint;
  /** sell side: nanoERG per smallest unit below which a leg waits; 0 for no floor (always 0 on the buy side) */
  minPrice: bigint;
  rentReserve: bigint;
  /** nanoERG in the box */
  value: bigint;
  /** token units in the box (sell side; 0 on the buy side) */
  tokens: bigint;
  creationHeight: number;
  /** the first height at which a leg is valid */
  dueAt: number;
  /** legs the box still funds, counting the last one */
  legsLeft: number;
  /** whether the next leg closes the box */
  last: boolean;
}

const hexOf = (bytes: Uint8Array) => bytes.reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");

export function describeClock(box: Box<Amount>): ClockView {
  const side: ClockSide | undefined =
    box.ergoTree === CLOCK_TREE ? "buy" : box.ergoTree === CLOCK_SELL_TREE ? "sell" : undefined;
  if (!side) throw new Error("not a clocked box");
  const r = box.additionalRegisters;
  if (!r.R4 || !r.R5 || !r.R6 || !r.R7) throw new Error("clocked box lacks a register");
  const params = SConstant.from<bigint[]>(r.R7).data.map(BigInt);
  if (params.length !== 6) throw new Error("clocked box R7 must hold six parameters");
  const [slice, interval, toleranceBps, executorFee, price, rentReserve] = params;
  const value = BigInt(box.value);
  const tokenId = hexOf(SConstant.from<Uint8Array>(r.R5).data);
  let legsLeft: number;
  let last: boolean;
  let tokens = 0n;
  if (side === "buy") {
    const budgetAfter = value - rentReserve - slice - executorFee;
    last = budgetAfter < slice + executorFee;
    const perLeg = slice + executorFee;
    const n = perLeg > 0n ? (value - rentReserve) / perLeg : 0n;
    legsLeft = value <= executorFee ? 0 : n >= 1n ? Number(n) : 1;
  } else {
    if (box.assets[0]?.tokenId !== tokenId) throw new Error("sell program does not hold its token first");
    tokens = BigInt(box.assets[0].amount);
    last = tokens - slice < slice;
    legsLeft = tokens <= 0n ? 0 : last ? 1 : Number(tokens / slice);
  }
  return {
    side,
    boxId: box.boxId,
    owner: ErgoAddress.fromPublicKey(SConstant.from<Uint8Array>(r.R4).data).encode(),
    tokenId,
    poolNft: hexOf(SConstant.from<Uint8Array>(r.R6).data),
    slice,
    interval,
    toleranceBps,
    executorFee,
    maxPrice: side === "buy" ? price : 0n,
    minPrice: side === "sell" ? price : 0n,
    rentReserve,
    value,
    tokens,
    creationHeight: box.creationHeight,
    dueAt: box.creationHeight + Number(interval),
    legsLeft,
    last,
  };
}

/** What both sides share at creation. */
interface ProgramBase {
  owner: ErgoAddress;
  tokenId: string;
  /** the pool the legs trade against; its NFT is pinned in the box */
  poolBox: Box<Amount>;
  interval: number;
  toleranceBps: bigint;
  executorFee: bigint;
}

export interface ClockProgram extends ProgramBase {
  /** nanoERG per leg */
  slice: bigint;
  /** nanoERG per smallest unit, 0 for none */
  maxPrice: bigint;
  legs: number;
}

export interface ClockSellProgram extends ProgramBase {
  /** token units in the box; legs = tokens / slice, the last leg selling any remainder with its slice */
  tokens: bigint;
  /** token units per leg */
  slice: bigint;
  /** nanoERG per smallest unit, 0 for none */
  minPrice: bigint;
}

function registersOf(p: ProgramBase, params: bigint[]) {
  const pk = p.owner.getPublicKeys()[0];
  if (!pk) throw new Error("the owner must be a P2PK address");
  return {
    R4: SSigmaProp(SGroupElement(pk)).toHex(),
    R5: SColl(SByte, p.tokenId).toHex(),
    R6: SColl(SByte, p.poolBox.assets[0].tokenId).toHex(),
    R7: SColl(SLong, params).toHex(),
  };
}

/** The registers of a new buy program. */
export function clockRegisters(p: ClockProgram, rentReserve: bigint) {
  return registersOf(p, [p.slice, BigInt(p.interval), p.toleranceBps, p.executorFee, p.maxPrice, rentReserve]);
}

/** The registers of a new sell program. */
export function clockSellRegisters(p: ClockSellProgram, rentReserve: bigint) {
  return registersOf(p, [p.slice, BigInt(p.interval), p.toleranceBps, p.executorFee, p.minPrice, rentReserve]);
}

function checkCommon(p: ProgramBase, legs: number) {
  const pool = describePool(p.poolBox);
  if (pool.tokenId !== p.tokenId) throw new Error("the pool does not hold the program's token");
  if (!Number.isInteger(legs) || legs < 1) throw new Error("legs must be a whole number of at least 1");
  if (!Number.isInteger(p.interval) || p.interval < 1) throw new Error("interval must be a whole number of blocks");
  if (legs * p.interval > RENT_PERIOD)
    throw new Error(`legs x interval must stay within one storage-rent period (${RENT_PERIOD} blocks)`);
  if (p.toleranceBps < 0n || p.toleranceBps > 10_000n) throw new Error("tolerance must be 0 to 10000 basis points");
  if (p.executorFee <= FEE + OWNER_BOX_VALUE)
    throw new Error(
      `executorFee must exceed the miner fee plus the owner's output (${FEE + OWNER_BOX_VALUE} nanoERG), or no one can run a leg`,
    );
}

/** One storage-rent fee for a box of these bytes. */
export const rentFee = (bytes: number) => BigInt(bytes) * STORAGE_FEE_FACTOR;

/**
 * Checks a buy program and sizes its box: value = legs x (slice + executorFee). No rent reserve: the box is ERG, so a
 * storage-rent claim on a box abandoned for a rent period takes its fee from the budget and leaves a smaller program
 * (or, if the box is smaller than the fee, the box); the schedule check keeps a program that runs within the period.
 * `rentFeeWouldBe` is what one claim would take, for the quote.
 */
export function sizeProgram(p: ClockProgram): {
  value: bigint;
  rentReserve: bigint;
  bytes: number;
  rentFeeWouldBe: bigint;
} {
  checkCommon(p, p.legs);
  if (p.slice <= 0n) throw new Error("slice must be positive");
  if (p.maxPrice < 0n) throw new Error("maxPrice must be 0 (none) or positive");
  const value = BigInt(p.legs) * (p.slice + p.executorFee);
  const bytes = estimateBoxSize({
    value,
    ergoTree: CLOCK_TREE,
    creationHeight: RENT_PERIOD * 4, // any height of the same encoded size as today's
    assets: [],
    additionalRegisters: clockRegisters(p, 0n),
  });
  return { value, rentReserve: 0n, bytes, rentFeeWouldBe: rentFee(bytes) };
}

/**
 * Checks a sell program and sizes its box: value = legs x executorFee + one storage-rent fee for the box's bytes (held
 * back, returned with the last leg) + the node's minimum for the box; legs = tokens / slice, the remainder sold with
 * the last slice.
 */
export function sizeProgramSell(p: ClockSellProgram): {
  value: bigint;
  rentReserve: bigint;
  minBox: bigint;
  bytes: number;
  legs: number;
} {
  if (p.slice <= 0n) throw new Error("slice must be positive");
  if (p.tokens < p.slice) throw new Error("the amount must be at least one slice");
  if (p.minPrice < 0n) throw new Error("minPrice must be 0 (none) or positive");
  const legs = Number(p.tokens / p.slice);
  checkCommon(p, legs);
  const legsValue = BigInt(legs) * p.executorFee;
  // the reserve depends on the box's bytes, which depend on the value's encoding: iterate to a fixed point
  let rentReserve = 0n;
  let minBox = 0n;
  let bytes = 0;
  for (let i = 0; i < 4; i++) {
    bytes = estimateBoxSize({
      value: legsValue + rentReserve + minBox,
      ergoTree: CLOCK_SELL_TREE,
      creationHeight: RENT_PERIOD * 4,
      assets: [{ tokenId: p.tokenId, amount: p.tokens }],
      additionalRegisters: clockSellRegisters(p, rentReserve),
    });
    const next = rentFee(bytes);
    if (next === rentReserve) break;
    rentReserve = next;
    minBox = BigInt(bytes) * MIN_VALUE_PER_BYTE;
  }
  return { value: legsValue + rentReserve + minBox, rentReserve, minBox, bytes, legs };
}

export interface CreateClockParams extends ClockProgram {
  height: number;
  inputs: Box<Amount>[];
}

/** The box is created at `height + 1`, the first block it can be mined in: the clock runs from there. */
export function buildCreateClock(p: CreateClockParams): EIP12UnsignedTransaction {
  const { value, rentReserve } = sizeProgram(p);
  const out = new OutputBuilder(value, CLOCK_TREE, p.height + 1).setAdditionalRegisters(clockRegisters(p, rentReserve));
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .to(out)
    .sendChangeTo(p.owner)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface CreateClockSellParams extends ClockSellProgram {
  height: number;
  inputs: Box<Amount>[];
}

export function buildCreateClockSell(p: CreateClockSellParams): EIP12UnsignedTransaction {
  const { value, rentReserve } = sizeProgramSell(p);
  const out = new OutputBuilder(value, CLOCK_SELL_TREE, p.height + 1)
    .addTokens({ tokenId: p.tokenId, amount: p.tokens })
    .setAdditionalRegisters(clockSellRegisters(p, rentReserve));
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .to(out)
    .sendChangeTo(p.owner)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface LegSize {
  side: ClockSide;
  /** into the trade: buy, nanoERG; sell, token units. The slice, or what is left on the last leg. */
  amt: bigint;
  /** what the trade yields for the owner: buy, token units; sell, nanoERG. The pool's rule for amt at its reserves, exactly. */
  got: bigint;
  last: boolean;
  /** whether the effective price is within the program's bound: under the cap (buy) or over the floor (sell) */
  priceOk: boolean;
  /** the owner's output value: buy, a box minimum (the remainder on the last leg); sell, the proceeds (plus the remainder on the last leg) */
  ownerValue: bigint;
  /** nanoERG to whoever builds the leg, after the miner fee */
  payout: bigint;
}

/** The leg a pool and a clocked box allow right now, before the question of whether it is due. */
export function sizeLeg(pool: PoolView, clock: ClockView, fee = FEE): LegSize {
  if (pool.nft !== clock.poolNft) throw new Error("the pool is not the program's pool");
  const last = clock.last;
  if (clock.side === "buy") {
    const amt = last ? bmin(clock.slice, clock.value - clock.executorFee) : clock.slice;
    const got = amt > 0n ? quote(pool, "erg-to-token", amt) : 0n;
    const priceOk = clock.maxPrice === 0n || amt <= clock.maxPrice * got;
    const ownerValue = last ? bmax(clock.value - amt - clock.executorFee, OWNER_BOX_VALUE) : OWNER_BOX_VALUE;
    const payout = last ? clock.value - amt - ownerValue - fee : clock.executorFee - ownerValue - fee;
    return { side: "buy", amt, got, last, priceOk, ownerValue, payout };
  }
  const amt = last ? clock.tokens : clock.slice;
  const got = amt > 0n ? quote(pool, "token-to-erg", amt) : 0n;
  const priceOk = clock.minPrice === 0n || got >= clock.minPrice * amt;
  // the owner's output carries the proceeds; a box below the node's minimum is topped up out of the executor's fee
  const ownerValue = last ? got + clock.value - clock.executorFee : bmax(got, OWNER_BOX_VALUE);
  const topUp = last ? 0n : ownerValue - got;
  const payout = clock.executorFee - topUp - fee;
  return { side: "sell", amt, got, last, priceOk, ownerValue, payout };
}

export interface LegParams {
  height: number;
  poolBox: Box<Amount>;
  clockBox: Box<Amount>;
  payTo: ErgoAddress;
}

/**
 * The keyless leg of either side, or undefined when it is not due, its price is outside the program's bound, or the
 * fee does not cover the miner fee. `force` builds it anyway (tests of the script's own refusals). The successor is
 * created at `height + 1`, the first block the leg can be mined in, so the next interval runs from there.
 */
export function buildLeg(
  p: LegParams,
  force = false,
): { tx: EIP12UnsignedTransaction; size: LegSize; clock: ClockView } | undefined {
  const pool = describePool(p.poolBox);
  const clock = describeClock(p.clockBox);
  const size = sizeLeg(pool, clock);
  const due = p.height - clock.creationHeight >= Number(clock.interval);
  if (!force && (!due || !size.priceOk || size.payout <= 0n || size.got <= 0n)) return undefined;
  const sell = clock.side === "sell";
  if (!sell && size.got >= pool.y) throw new Error("the leg would empty the pool");
  if (sell && pool.x - size.got <= POOL_MIN_VALUE) throw new Error("the leg would take the pool to its minimum ERG");
  const poolOut = new OutputBuilder(sell ? pool.x - size.got : pool.x + size.amt, POOL_TREE)
    .addTokens([
      { tokenId: pool.nft, amount: 1n },
      { tokenId: pool.lpTokenId, amount: BigInt(p.poolBox.assets[1].amount) },
      { tokenId: pool.tokenId, amount: sell ? pool.y + size.amt : pool.y - size.got },
    ])
    .setAdditionalRegisters({ R4: p.poolBox.additionalRegisters.R4 as string });
  const ownerOut = new OutputBuilder(size.ownerValue, ErgoAddress.fromBase58(clock.owner)).setAdditionalRegisters({
    R4: SColl(SByte, clock.boxId).toHex(),
  });
  if (!sell) ownerOut.addTokens({ tokenId: clock.tokenId, amount: size.got });
  const outputs = [poolOut, ownerOut];
  const vars: Record<number, SConstant<number>> = { 0: SInt(1) };
  if (!size.last) {
    const r = p.clockBox.additionalRegisters;
    const next = new OutputBuilder(
      sell ? clock.value - clock.executorFee : clock.value - clock.slice - clock.executorFee,
      p.clockBox.ergoTree,
      p.height + 1,
    ).setAdditionalRegisters({ R4: r.R4 as string, R5: r.R5 as string, R6: r.R6 as string, R7: r.R7 as string });
    if (sell) next.addTokens({ tokenId: clock.tokenId, amount: clock.tokens - size.amt });
    outputs.push(next);
    vars[1] = SInt(2);
  }
  outputs.push(new OutputBuilder(size.payout > 0n ? size.payout : 1n, p.payTo));
  const clockIn = new ErgoUnsignedInput(p.clockBox).setContextExtension(vars);
  const tx = new TransactionBuilder(p.height)
    .from([p.poolBox, clockIn])
    .to(outputs)
    .payFee(FEE)
    .build()
    .toEIP12Object();
  return { tx, size, clock };
}

export interface CancelClockParams {
  height: number;
  owner: ErgoAddress;
  clockBox: Box<Amount>;
}

/** The owner takes everything back, tokens included; the box itself pays the miner fee. The owner's wallet signs the box. */
export function buildCancelClock(p: CancelClockParams): EIP12UnsignedTransaction {
  const clock = describeClock(p.clockBox);
  if (p.owner.encode() !== clock.owner) throw new Error("only the owner can cancel");
  if (clock.value <= FEE) throw new Error("the box no longer covers a miner fee");
  const out = new OutputBuilder(clock.value - FEE, p.owner).setAdditionalRegisters({
    R4: SColl(SByte, clock.boxId).toHex(),
  });
  if (p.clockBox.assets.length > 0)
    out.addTokens(p.clockBox.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })));
  return new TransactionBuilder(p.height).from([p.clockBox]).to(out).payFee(FEE).build().toEIP12Object();
}

/** "3 blocks (about 6 minutes)" or "720 blocks (about 1 day)". */
export function describeInterval(blocks: number): string {
  if (blocks >= BLOCKS_PER_DAY) {
    const d = blocks / BLOCKS_PER_DAY;
    return `${blocks} blocks (about ${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? "" : "s"})`;
  }
  const h = blocks / 30;
  if (blocks >= 30)
    return `${blocks} blocks (about ${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"})`;
  return `${blocks} blocks (about ${blocks * 2} minutes)`;
}

const bmin = (a: bigint, b: bigint) => (a < b ? a : b);
const bmax = (a: bigint, b: bigint) => (a > b ? a : b);
