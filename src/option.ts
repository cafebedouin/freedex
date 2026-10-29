// The option as a timed escrow (contracts/Call.es and contracts/Put.es, skunkyard SK-065): a standing offer one party
// pays to hold, that the writer cannot withdraw until a date. A call holds tokens the named buyer may buy at the
// strike at or before the expiry; a put holds the ERG collateral the named buyer may sell tokens into at the strike.
// Anyone becomes the buyer by paying the premium to the writer; after the expiry the writer takes the box back; while
// unsold the writer may cancel at any time. Pure builders, no DOM, no network.
//   write:    the writer locks the underlying (a call: the tokens and one storage-rent fee for the box's bytes, since
//             a token box that cannot pay rent is consumed whole; a put: strike x amount of ERG, nothing more) and
//             the terms; refused when the expiry is past one rent period away.
//   buy:      keyless; outputs 0 the premium to the writer, 1 the successor with the buyer in R7; the buyer's own
//             boxes pay the premium and the miner fee.
//   exercise: the buyer's key; a call: outputs 0 the box's ERG plus strike x amount to the writer, 1 the tokens to
//             the buyer; a put: 0 the tokens to the writer, 1 the box's ERG to the buyer.
//   reclaim:  the writer's key, after the expiry or while unsold; everything back, the fee from the writer's boxes.
// Every output of a buy or exercise, and the refund, carries the spent box's id in R4. The builders follow the
// clocked box's rule that the node evaluates the next block: a buy or exercise is built only while the height is
// below the expiry, a reclaim once it has reached it.
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
import { MIN_VALUE_PER_BYTE, OWNER_BOX_VALUE, RENT_PERIOD, rentFee } from "./clock.ts";
import { FEE } from "./orders.ts";

/** contracts/Call.es compiled by scripts/compile-option.ts (ErgoTree v1, segregated constants); pinned by test/hashes.test.ts. */
export const CALL_TREE =
  "19f2020804040402040004060100040004020100d80dd601e4c6a70408d602c6a70708d603e67202d604ef7203d6057ea305d606e4c6a70611d607b27206730000d608e30004d609c2a7d60ae4c6a7050ed60b9072057207d60c93b1b5a4d9010c6393c2720c72097301d60db27206730200eb02eb02ea027201d1ec72049172057207d195ed7204e67208d802d60eb2a5e4720800d60fb2a5e4e301040096830c01720b720c93c2720ed0720192c1720eb2720673030093e4c6720e040ec5a793c2720f720992c1720fc1a793db6308720fdb6308a793e4c6720f0408720193e4c6720f050e720a93e4c6720f06117206e6c6720f0708730495ed7203e67208d805d60ee47202d60fb2a5e4720800d610c5a7d611b2a5e4e3010400d612b2db63087211730500ea02720ed196830901720b720c93c2720fd0720192c1720f9ac1a79cb27206730600720d93e4c6720f040e721093c27211d0720e938c721201720a928c721202720d93e4c67211040e7210d17307";
/** SHA-256 of the template, what the explorer's unspent search takes. */
export const CALL_TEMPLATE_SHA256 = "da26dcb30f5bbc60853ef35aa2f8a5530838fc8ab6cfe468b8f57ef79ed8cf8e";
/** contracts/Put.es, compiled the same way. */
export const PUT_TREE =
  "19e202070404040204060100040004000100d80cd601e4c6a70408d602c6a70708d603e67202d604ef7203d6057ea305d606e4c6a70611d607b27206730000d608e30004d609c2a7d60ae4c6a7050ed60b9072057207d60c93b1b5a4d9010c6393c2720c72097301eb02eb02ea027201d1ec72049172057207d195ed7204e67208d802d60db2a5e4720800d60eb2a5e4e301040096830c01720b720c93c2720dd0720192c1720db2720673020093e4c6720d040ec5a793c2720e720992c1720ec1a793db6308720edb6308a793e4c6720e0408720193e4c6720e050e720a93e4c6720e06117206e6c6720e0708730395ed7203e67208d805d60de47202d60eb2a5e4720800d60fb2db6308720e730400d610c5a7d611b2a5e4e3010400ea02720dd196830901720b720c93c2720ed07201938c720f01720a928c720f02b2720673050093e4c6720e040e721093c27211d0720d92c17211c1a793e4c67211040e7210d17306";
export const PUT_TEMPLATE_SHA256 = "1296e3affd097a964dd1cafcd59d61f2ec3b6d0b92c745f45804a4df6aba241c";

export type OptionSide = "call" | "put";
export const LONG_MAX = 9_223_372_036_854_775_807n;

export interface OptionView {
  side: OptionSide;
  boxId: string;
  writer: string;
  /** the named buyer's address once sold */
  buyer?: string;
  sold: boolean;
  tokenId: string;
  /** units of the underlying */
  amount: bigint;
  /** nanoERG per smallest unit */
  strike: bigint;
  /** strike x amount, nanoERG: what the buyer pays (call) or receives (put) on exercise */
  strikeTotal: bigint;
  /** the last height at which the option may be exercised */
  expiry: number;
  premium: bigint;
  /** nanoERG in the box: a call's rent reserve, a put's collateral */
  value: bigint;
  creationHeight: number;
}

const hexOf = (bytes: Uint8Array) => bytes.reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
const sigmaAddress = (reg: string) => ErgoAddress.fromPublicKey(SConstant.from<Uint8Array>(reg).data).encode();

export function sideOf(tree: string): OptionSide | undefined {
  return tree === CALL_TREE ? "call" : tree === PUT_TREE ? "put" : undefined;
}

export function describeOption(box: Box<Amount>): OptionView {
  const side = sideOf(box.ergoTree);
  if (!side) throw new Error("not an option box");
  const r = box.additionalRegisters;
  if (!r.R4 || !r.R5 || !r.R6) throw new Error("option box lacks a register");
  const terms = SConstant.from<bigint[]>(r.R6).data.map(BigInt);
  if (terms.length !== 4) throw new Error("option box R6 must hold four terms");
  const [amount, strike, expiry, premium] = terms;
  const tokenId = hexOf(SConstant.from<Uint8Array>(r.R5).data);
  if (side === "call" && box.assets[0]?.tokenId !== tokenId) throw new Error("call box does not hold its token first");
  return {
    side,
    boxId: box.boxId,
    writer: sigmaAddress(r.R4),
    buyer: r.R7 ? sigmaAddress(r.R7) : undefined,
    sold: !!r.R7,
    tokenId,
    amount,
    strike,
    strikeTotal: strike * amount,
    expiry: Number(expiry),
    premium,
    value: BigInt(box.value),
    creationHeight: box.creationHeight,
  };
}

export interface OptionTerms {
  side: OptionSide;
  writer: ErgoAddress;
  tokenId: string;
  amount: bigint;
  /** nanoERG per smallest unit */
  strike: bigint;
  expiry: number;
  premium: bigint;
}

function sigmaOf(a: ErgoAddress) {
  const pk = a.getPublicKeys()[0];
  if (!pk) throw new Error("the address must be a P2PK address");
  return SSigmaProp(SGroupElement(pk)).toHex();
}

export function optionRegisters(t: OptionTerms, buyer?: ErgoAddress) {
  const regs: Record<string, string> = {
    R4: sigmaOf(t.writer),
    R5: SColl(SByte, t.tokenId).toHex(),
    R6: SColl(SLong, [t.amount, t.strike, BigInt(t.expiry), t.premium]).toHex(),
  };
  if (buyer) regs.R7 = sigmaOf(buyer);
  return regs;
}

/**
 * Checks the terms against the height they are written at and sizes the box. A call holds the tokens and one
 * storage-rent fee for the bytes of the sold box (the buyer's register adds to the unsold one), because a token box
 * that cannot pay rent is consumed whole; a put holds strike x amount, the collateral, and nothing more.
 */
export function sizeWrite(t: OptionTerms, height: number): { value: bigint; bytes: number; rentReserve: bigint } {
  if (t.amount <= 0n) throw new Error("amount must be positive");
  if (t.strike <= 0n) throw new Error("strike must be positive");
  if (t.premium < OWNER_BOX_VALUE)
    throw new Error(`premium must be at least ${OWNER_BOX_VALUE} nanoERG, the smallest box that can carry it`);
  if (!Number.isInteger(t.expiry) || t.expiry <= height) throw new Error("expiry must be a height after now");
  if (t.expiry - height > RENT_PERIOD)
    throw new Error(`expiry must be within one storage-rent period (${RENT_PERIOD} blocks) of now`);
  if (t.strike > LONG_MAX / t.amount) throw new Error("strike x amount does not fit a Long");
  const strikeTotal = t.strike * t.amount;
  const regs = optionRegisters(t, t.writer); // sized as sold: any P2PK buyer takes the same bytes
  const estimate = (value: bigint) =>
    estimateBoxSize({
      value,
      ergoTree: t.side === "call" ? CALL_TREE : PUT_TREE,
      creationHeight: RENT_PERIOD * 4,
      assets: t.side === "call" ? [{ tokenId: t.tokenId, amount: t.amount }] : [],
      additionalRegisters: regs,
    });
  if (t.side === "put") {
    const bytes = estimate(strikeTotal);
    if (strikeTotal < BigInt(bytes) * MIN_VALUE_PER_BYTE)
      throw new Error(`the collateral (${strikeTotal} nanoERG) is below the node's minimum for a ${bytes}-byte box`);
    if (strikeTotal > LONG_MAX - FEE) throw new Error("strike x amount does not fit a Long");
    return { value: strikeTotal, bytes, rentReserve: 0n };
  }
  if (strikeTotal > LONG_MAX / 2n) throw new Error("strike x amount plus the box's value does not fit a Long");
  let rentReserve = 0n;
  let bytes = 0;
  for (let i = 0; i < 4; i++) {
    bytes = estimate(rentReserve);
    const next = rentFee(bytes);
    if (next === rentReserve) break;
    rentReserve = next;
  }
  return { value: rentReserve, bytes, rentReserve };
}

export interface WriteParams extends OptionTerms {
  height: number;
  inputs: Box<Amount>[];
}

/** The writer locks the underlying and the terms; R7 absent. */
export function buildWrite(p: WriteParams): EIP12UnsignedTransaction {
  const { value } = sizeWrite(p, p.height);
  const out = new OutputBuilder(value, p.side === "call" ? CALL_TREE : PUT_TREE).setAdditionalRegisters(
    optionRegisters(p),
  );
  if (p.side === "call") out.addTokens({ tokenId: p.tokenId, amount: p.amount });
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .to(out)
    .sendChangeTo(p.writer)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/** Whether a buy can be built now: unsold, and the next block still at or before the expiry. */
export const canBuy = (v: OptionView, height: number) => !v.sold && height < v.expiry;
/** Whether the named buyer can exercise now. */
export const canExercise = (v: OptionView, height: number, buyer?: string) =>
  v.sold && height < v.expiry && (buyer === undefined || v.buyer === buyer);
/** Whether the writer can take the box back now: unsold, or the next block past the expiry. */
export const canReclaim = (v: OptionView, height: number) => !v.sold || height >= v.expiry;

const bound = (id: string) => ({ R4: SColl(SByte, id).toHex() });

export interface BuyParams {
  height: number;
  inputs: Box<Amount>[];
  buyer: ErgoAddress;
  optionBox: Box<Amount>;
}

/** Anyone pays the premium to the writer and recreates the box with themselves as the buyer in R7. */
export function buildBuy(p: BuyParams): EIP12UnsignedTransaction {
  const v = describeOption(p.optionBox);
  if (v.sold) throw new Error("this option is already sold");
  if (p.height >= v.expiry) throw new Error("this option has expired or expires in the next block");
  const r = p.optionBox.additionalRegisters;
  const pay = new OutputBuilder(v.premium, ErgoAddress.fromBase58(v.writer)).setAdditionalRegisters(bound(v.boxId));
  const next = new OutputBuilder(v.value, p.optionBox.ergoTree).setAdditionalRegisters({
    R4: r.R4 as string,
    R5: r.R5 as string,
    R6: r.R6 as string,
    R7: sigmaOf(p.buyer),
  });
  if (p.optionBox.assets.length > 0)
    next.addTokens(p.optionBox.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })));
  const optionIn = new ErgoUnsignedInput(p.optionBox).setContextExtension({ 0: SInt(0), 1: SInt(1) });
  return new TransactionBuilder(p.height)
    .from([optionIn, ...p.inputs])
    .configureSelector((s) => s.ensureInclusion([p.optionBox.boxId]))
    .to([pay, next])
    .sendChangeTo(p.buyer)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface ExerciseParams {
  height: number;
  inputs: Box<Amount>[];
  buyer: ErgoAddress;
  optionBox: Box<Amount>;
}

/**
 * The named buyer exercises: a call, strike x amount plus the box's ERG to the writer and the tokens to the buyer;
 * a put, the tokens to the writer and the box's ERG to the buyer. The buyer's boxes pay the miner fee and the
 * minimum value of the token output. The buyer's wallet signs the option box.
 */
export function buildExercise(p: ExerciseParams): EIP12UnsignedTransaction {
  const v = describeOption(p.optionBox);
  if (!v.sold) throw new Error("this option is unsold");
  if (p.buyer.encode() !== v.buyer) throw new Error("only the named buyer can exercise");
  if (p.height >= v.expiry) throw new Error("this option has expired or expires in the next block");
  const writer = ErgoAddress.fromBase58(v.writer);
  let pay: OutputBuilder, get: OutputBuilder;
  if (v.side === "call") {
    pay = new OutputBuilder(v.value + v.strikeTotal, writer).setAdditionalRegisters(bound(v.boxId));
    get = new OutputBuilder(OWNER_BOX_VALUE, p.buyer)
      .addTokens({ tokenId: v.tokenId, amount: v.amount })
      .setAdditionalRegisters(bound(v.boxId));
  } else {
    pay = new OutputBuilder(OWNER_BOX_VALUE, writer)
      .addTokens({ tokenId: v.tokenId, amount: v.amount })
      .setAdditionalRegisters(bound(v.boxId));
    get = new OutputBuilder(v.value, p.buyer).setAdditionalRegisters(bound(v.boxId));
  }
  const optionIn = new ErgoUnsignedInput(p.optionBox).setContextExtension({ 0: SInt(0), 1: SInt(1) });
  return new TransactionBuilder(p.height)
    .from([optionIn, ...p.inputs])
    .configureSelector((s) => s.ensureInclusion([p.optionBox.boxId]))
    .to([pay, get])
    .sendChangeTo(p.buyer)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface ReclaimParams {
  height: number;
  inputs: Box<Amount>[];
  writer: ErgoAddress;
  optionBox: Box<Amount>;
}

/** The writer takes everything back: after the expiry, or at any time while unsold. The writer's boxes pay the fee. */
export function buildReclaim(p: ReclaimParams): EIP12UnsignedTransaction {
  const v = describeOption(p.optionBox);
  if (p.writer.encode() !== v.writer) throw new Error("only the writer can reclaim");
  if (!canReclaim(v, p.height)) throw new Error(`this option is sold and open until height ${v.expiry}`);
  const refund = new OutputBuilder(v.value, p.writer).setAdditionalRegisters(bound(v.boxId));
  if (p.optionBox.assets.length > 0)
    refund.addTokens(p.optionBox.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })));
  return new TransactionBuilder(p.height)
    .from([p.optionBox, ...p.inputs])
    .configureSelector((s) => s.ensureInclusion([p.optionBox.boxId]))
    .to(refund)
    .sendChangeTo(p.writer)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/** The writer cancels an unsold offer; the same transaction as a reclaim, refused once the option is sold. */
export function buildCancelUnsold(p: ReclaimParams): EIP12UnsignedTransaction {
  if (describeOption(p.optionBox).sold) throw new Error("this option is sold; it can be reclaimed after its expiry");
  return buildReclaim(p);
}
