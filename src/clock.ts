// The clocked box (contracts/Clock.es, skunkyard SK-064): a box of ERG anyone may act on once per interval, buying
// one slice from one ErgoDEX v1 ERG pool for the owner, a bounded fee to whoever builds the leg. Dollar-cost
// averaging, a rate limit, and (mirrored) a tranche sale, in one contract. Pure builders, no DOM, no network.
//   create: the owner funds the box (legs x (slice + executorFee) + a storage-rent reserve that comes back last)
//   leg:    keyless; inputs 0 pool, 1 clock; outputs 0 pool successor, 1 the owner's tokens, 2 the successor
//           (not on the last leg), then the executor's payout and the miner fee, which both come out of executorFee
//   cancel: the owner's key, everything back, any time
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
import { POOL_TREE, describePool, quote, type PoolView } from "./amm.ts";
import { FEE } from "./orders.ts";

/** contracts/Clock.es compiled by scripts/compile-clock.ts (ErgoTree v1, segregated constants, SLACK 4); pinned by test/hashes.test.ts. */
export const CLOCK_TREE =
  "19f50313040204000406040804000404040a040004020400050006022710060203e805a09c0104040500040004080100d809d601e4c6a70408d602e30004d603e4c6a70711d604b27203730000d605e4c6a7060ed606e4c6a7050ed607b27203730100d608b27203730200d609b27203730300eb027201d195e67202d80dd60a8cc7a701d60bc2a7d60cb2a4730400d60ddb6308720cd60eb2720d730500d60fc1a7d6108f999999720fb27203730600720772089a72077208d611957210a1720799720f72087207d612b2a5e4720200d613b2db63087212730700d6147e8c72130206d6157e721106d6167ee4c6720c04040696830901927e99a3720a05720493b1b5a4d901176393c27217720b7308938cb2720d730900017205938c720e017206917211730a929c7214730b9c9d9c9c7e8c720e0206721572169a9c7ec1720c06730c9c721572167e99730db27203730e0006ec937209730f9072159c7e72090672149683030193c27212d0720193e4c67212040ec5a7938c721301720695721092c172129999720f72117208d802d617b2a5e4e3010400d6188cc77217019683090193c27217720b92c172179999720f7207720893b1db63087217731093e4c672170408720193e4c67217050e720693e4c67217060e720593e4c672170711720392721899a37311927e7218059a7e720a0572047312";
/** SHA-256 of the template, what the explorer's unspent search takes. */
export const CLOCK_TEMPLATE_SHA256 = "a1df056602fa8628c9169bbf947ec7121ea123b1e03b4b6f73de54712f5f7e7e";
/** Blocks an executor may backdate a successor; also how long a built leg stays valid (Clock.es, SLACK). */
export const CLOCK_SLACK = 4;
/** One storage-rent period, blocks; a program whose legs x interval passes it is refused at creation. */
export const RENT_PERIOD = 1_051_200;
/** Mainnet storage fee per byte per period, nanoERG (networkState.params.storageFeeFactor, 2026-10-29). */
export const STORAGE_FEE_FACTOR = 1_250_000n;
/** ERG the owner's token output carries on a leg that is not the last; it comes out of the executor's fee. */
export const OWNER_BOX_VALUE = 100_000n;
/** Mainnet blocks per day, for showing an interval. */
export const BLOCKS_PER_DAY = 720;

export interface ClockView {
  boxId: string;
  owner: string;
  tokenId: string;
  poolNft: string;
  slice: bigint;
  interval: bigint;
  toleranceBps: bigint;
  executorFee: bigint;
  /** nanoERG per smallest unit; 0 for no cap */
  maxPrice: bigint;
  rentReserve: bigint;
  value: bigint;
  creationHeight: number;
  /** the first height at which a leg is valid */
  dueAt: number;
  /** legs the box still funds, counting the last one */
  legsLeft: number;
  /** whether the next leg closes the box */
  last: boolean;
}

export function describeClock(box: Box<Amount>): ClockView {
  if (box.ergoTree !== CLOCK_TREE) throw new Error("not a clocked box");
  const r = box.additionalRegisters;
  if (!r.R4 || !r.R5 || !r.R6 || !r.R7) throw new Error("clocked box lacks a register");
  const params = SConstant.from<bigint[]>(r.R7).data.map(BigInt);
  if (params.length !== 6) throw new Error("clocked box R7 must hold six parameters");
  const [slice, interval, toleranceBps, executorFee, maxPrice, rentReserve] = params;
  const value = BigInt(box.value);
  const budgetAfter = value - rentReserve - slice - executorFee;
  const last = budgetAfter < slice + executorFee;
  const perLeg = slice + executorFee;
  const n = perLeg > 0n ? (value - rentReserve) / perLeg : 0n;
  const legsLeft = value <= executorFee ? 0 : n >= 1n ? Number(n) : 1;
  return {
    boxId: box.boxId,
    owner: ErgoAddress.fromPublicKey(SConstant.from<Uint8Array>(r.R4).data).encode(),
    tokenId: SConstant.from<Uint8Array>(r.R5).data.reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""),
    poolNft: SConstant.from<Uint8Array>(r.R6).data.reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""),
    slice,
    interval,
    toleranceBps,
    executorFee,
    maxPrice,
    rentReserve,
    value,
    creationHeight: box.creationHeight,
    dueAt: box.creationHeight + Number(interval),
    legsLeft,
    last,
  };
}

export interface ClockProgram {
  owner: ErgoAddress;
  tokenId: string;
  /** the pool the legs trade against; its NFT is pinned in the box */
  poolBox: Box<Amount>;
  slice: bigint;
  interval: number;
  toleranceBps: bigint;
  executorFee: bigint;
  /** nanoERG per smallest unit, 0 for none */
  maxPrice: bigint;
  legs: number;
}

/** The registers of a new clocked box. */
export function clockRegisters(p: ClockProgram, rentReserve: bigint) {
  const pk = p.owner.getPublicKeys()[0];
  if (!pk) throw new Error("the owner must be a P2PK address");
  return {
    R4: SSigmaProp(SGroupElement(pk)).toHex(),
    R5: SColl(SByte, p.tokenId).toHex(),
    R6: SColl(SByte, p.poolBox.assets[0].tokenId).toHex(),
    R7: SColl(SLong, [p.slice, BigInt(p.interval), p.toleranceBps, p.executorFee, p.maxPrice, rentReserve]).toHex(),
  };
}

/** Checks a program and sizes its box: value = legs x (slice + executorFee) + one storage-rent fee for the box's bytes. */
export function sizeProgram(p: ClockProgram): { value: bigint; rentReserve: bigint; bytes: number } {
  const pool = describePool(p.poolBox);
  if (pool.tokenId !== p.tokenId) throw new Error("the pool does not hold the program's token");
  if (!Number.isInteger(p.legs) || p.legs < 1) throw new Error("legs must be a whole number of at least 1");
  if (!Number.isInteger(p.interval) || p.interval < 1) throw new Error("interval must be a whole number of blocks");
  if (p.legs * p.interval > RENT_PERIOD)
    throw new Error(`legs x interval must stay within one storage-rent period (${RENT_PERIOD} blocks)`);
  if (p.slice <= 0n) throw new Error("slice must be positive");
  if (p.toleranceBps < 0n || p.toleranceBps > 10_000n) throw new Error("tolerance must be 0 to 10000 basis points");
  if (p.maxPrice < 0n) throw new Error("maxPrice must be 0 (none) or positive");
  if (p.executorFee <= FEE + OWNER_BOX_VALUE)
    throw new Error(
      `executorFee must exceed the miner fee plus the owner's output (${FEE + OWNER_BOX_VALUE} nanoERG), or no one can run a leg`,
    );
  const legsValue = BigInt(p.legs) * (p.slice + p.executorFee);
  // the reserve depends on the box's bytes, which depend on the value's encoding: iterate to a fixed point
  let rentReserve = 0n;
  let bytes = 0;
  for (let i = 0; i < 4; i++) {
    const value = legsValue + rentReserve;
    bytes = estimateBoxSize({
      value,
      ergoTree: CLOCK_TREE,
      creationHeight: RENT_PERIOD * 4, // any height of the same encoded size as today's
      assets: [],
      additionalRegisters: clockRegisters(p, rentReserve),
    });
    const next = BigInt(bytes) * STORAGE_FEE_FACTOR;
    if (next === rentReserve) break;
    rentReserve = next;
  }
  return { value: legsValue + rentReserve, rentReserve, bytes };
}

export interface CreateClockParams extends ClockProgram {
  height: number;
  inputs: Box<Amount>[];
}

export function buildCreateClock(p: CreateClockParams): EIP12UnsignedTransaction {
  const { value, rentReserve } = sizeProgram(p);
  const out = new OutputBuilder(value, CLOCK_TREE).setAdditionalRegisters(clockRegisters(p, rentReserve));
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .to(out)
    .sendChangeTo(p.owner)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface LegSize {
  /** nanoERG into the trade: the slice, or what is left on the last leg */
  amt: bigint;
  /** tokens the owner receives: the pool's rule for amt at its reserves, exactly */
  got: bigint;
  last: boolean;
  /** whether the effective price is within the program's cap */
  capOk: boolean;
  /** the owner's output value: a box minimum, or the remainder on the last leg */
  ownerValue: bigint;
  /** nanoERG to whoever builds the leg, after the miner fee */
  payout: bigint;
}

/** The leg a pool and a clocked box allow right now, before the question of whether it is due. */
export function sizeLeg(pool: PoolView, clock: ClockView, fee = FEE): LegSize {
  if (pool.nft !== clock.poolNft) throw new Error("the pool is not the program's pool");
  const last = clock.last;
  const amt = last ? bmin(clock.slice, clock.value - clock.executorFee) : clock.slice;
  const got = amt > 0n ? quote(pool, "erg-to-token", amt) : 0n;
  const capOk = clock.maxPrice === 0n || amt <= clock.maxPrice * got;
  const ownerValue = last ? bmax(clock.value - amt - clock.executorFee, OWNER_BOX_VALUE) : OWNER_BOX_VALUE;
  const payout = last ? clock.value - amt - ownerValue - fee : clock.executorFee - ownerValue - fee;
  return { amt, got, last, capOk, ownerValue, payout };
}

export interface LegParams {
  height: number;
  poolBox: Box<Amount>;
  clockBox: Box<Amount>;
  payTo: ErgoAddress;
}

/**
 * The keyless leg, or undefined when it is not due, its price is above the cap, or the fee does not cover the miner
 * fee. `force` builds it anyway (tests of the script's own refusals).
 */
export function buildLeg(
  p: LegParams,
  force = false,
): { tx: EIP12UnsignedTransaction; size: LegSize; clock: ClockView } | undefined {
  const pool = describePool(p.poolBox);
  const clock = describeClock(p.clockBox);
  const size = sizeLeg(pool, clock);
  const due = p.height - clock.creationHeight >= Number(clock.interval);
  if (!force && (!due || !size.capOk || size.payout <= 0n || size.got <= 0n)) return undefined;
  if (size.got >= pool.y) throw new Error("the leg would empty the pool");
  const poolOut = new OutputBuilder(pool.x + size.amt, POOL_TREE)
    .addTokens([
      { tokenId: pool.nft, amount: 1n },
      { tokenId: pool.lpTokenId, amount: BigInt(p.poolBox.assets[1].amount) },
      { tokenId: pool.tokenId, amount: pool.y - size.got },
    ])
    .setAdditionalRegisters({ R4: p.poolBox.additionalRegisters.R4 as string });
  const ownerOut = new OutputBuilder(size.ownerValue, ErgoAddress.fromBase58(clock.owner))
    .addTokens({ tokenId: clock.tokenId, amount: size.got })
    .setAdditionalRegisters({ R4: SColl(SByte, clock.boxId).toHex() });
  const outputs = [poolOut, ownerOut];
  const vars: Record<number, SConstant<number>> = { 0: SInt(1) };
  if (!size.last) {
    const r = p.clockBox.additionalRegisters;
    outputs.push(
      new OutputBuilder(clock.value - clock.slice - clock.executorFee, CLOCK_TREE).setAdditionalRegisters({
        R4: r.R4 as string,
        R5: r.R5 as string,
        R6: r.R6 as string,
        R7: r.R7 as string,
      }),
    );
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

/** The owner takes everything back; the box itself pays the miner fee. The owner's wallet signs the box. */
export function buildCancelClock(p: CancelClockParams): EIP12UnsignedTransaction {
  const clock = describeClock(p.clockBox);
  if (p.owner.encode() !== clock.owner) throw new Error("only the owner can cancel");
  if (clock.value <= FEE) throw new Error("the box no longer covers a miner fee");
  return new TransactionBuilder(p.height)
    .from([p.clockBox])
    .to(new OutputBuilder(clock.value - FEE, p.owner).setAdditionalRegisters({ R4: SColl(SByte, clock.boxId).toHex() }))
    .payFee(FEE)
    .build()
    .toEIP12Object();
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
