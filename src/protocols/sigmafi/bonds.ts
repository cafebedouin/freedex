// SigmaFi peer-to-peer bonds (capt-nemo429/sigmafi-ui, MIT), on the contracts as deployed. A borrower opens an
// order (collateral locked, principal, repayment, term); a lender closes it into a bond; the borrower repays before
// maturity or the lender takes the collateral after. The deployed order contract pays a 0.5% developer fee to a fixed
// address on every loan, which this page cannot remove and shows. Its 0.4% "UI fee" goes to whichever address closes
// the order, so the page points it at the lender and it returns to them.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, ErgoUnsignedInput, OutputBuilder, SAFE_MIN_BOX_VALUE, TransactionBuilder } from "@fleet-sdk/core";
import { blake2b256, hex } from "@fleet-sdk/crypto";
import { SByte, SColl, SConstant, SGroupElement, SInt, SLong, SSigmaProp } from "@fleet-sdk/serializer";
import { contract, fillTemplate, hashOf, treeOf } from "../../registry.ts";
import { FEE } from "../machina/orders.ts";

export const ERG = "ERG";
export const STORAGE_PERIOD = 1_051_200;
export const DEV_FEE_PER_100K = 500n;
export const UI_FEE_PER_100K = 400n;
/** The template hashes the explorer queries take, from src/registry.json. */
export const SIGMAFI_TEMPLATES = {
  orderOnCloseErg: hashOf("sigmafi-order-on-close-erg"),
  orderOnCloseToken: hashOf("sigmafi-order-on-close-token"),
  bondErg: hashOf("sigmafi-bond-erg"),
  bondToken: hashOf("sigmafi-bond-token"),
};
/** The P2PK tree the order contract pays its developer fee to. */
export const DEV_FEE_TREE = treeOf("sigmafi-dev-fee-recipient");

/** The hex before a template's first placeholder: a deployed tree starting with it is an instance of the template. */
const prefixOf = (id: string) => contract(id).template!.split("{")[0];

export function bondContract(tokenId: string): string {
  return tokenId === ERG ? treeOf("sigmafi-bond-erg") : fillTemplate("sigmafi-bond-token", { tokenId });
}

/** The "on close" order contract (the term starts when a lender closes the order), ERG or token principal. */
export function orderContract(tokenId: string): string {
  if (tokenId === ERG) return treeOf("sigmafi-order-on-close-erg");
  const bondTreeBlake2b256 = hex.encode(blake2b256(hex.decode(bondContract(tokenId))));
  return fillTemplate("sigmafi-order-on-close-token", { tokenId, bondTreeBlake2b256 });
}

function principalOfOrder(tree: string): string {
  const p = prefixOf("sigmafi-order-on-close-token");
  return tree.startsWith(p) ? tree.slice(p.length, p.length + 64) : ERG;
}
function principalOfBond(tree: string): string {
  const p = prefixOf("sigmafi-bond-token");
  return tree.startsWith(p) ? tree.slice(p.length, p.length + 64) : ERG;
}

export interface LoanView {
  boxId: string;
  principalId: string;
  principal: bigint;
  repayment: bigint;
  /** blocks; for an order the term, for a bond the maturity height */
  term: number;
  borrower: string;
  /** collateral: the box's whole ERG when it is more than a minimum box (the order's own value is the collateral), and its tokens */
  collateralErg: bigint;
  collateralTokens: { tokenId: string; amount: bigint }[];
}

export interface BondView extends LoanView {
  lender: string;
  maturity: number;
}

const pk = (sigmaPropHex: string) => ErgoAddress.fromPublicKey(SConstant.from<Uint8Array>(sigmaPropHex).data).encode();

export function describeOrder(box: Box<Amount>): LoanView {
  const r = box.additionalRegisters;
  if (!r.R4 || !r.R5 || !r.R6 || !r.R7) throw new Error("order box lacks a register");
  const principalId = principalOfOrder(box.ergoTree);
  if (box.ergoTree !== orderContract(principalId)) throw new Error("not a SigmaFi open order");
  return {
    boxId: box.boxId,
    principalId,
    principal: BigInt(SConstant.from<bigint>(r.R5).data),
    repayment: BigInt(SConstant.from<bigint>(r.R6).data),
    term: Number(SConstant.from<number>(r.R7).data),
    borrower: pk(r.R4),
    collateralErg: BigInt(box.value) > SAFE_MIN_BOX_VALUE ? BigInt(box.value) : 0n,
    collateralTokens: box.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
  };
}

export function describeBond(box: Box<Amount>): BondView {
  const r = box.additionalRegisters;
  if (!r.R4 || !r.R5 || !r.R6 || !r.R7 || !r.R8) throw new Error("bond box lacks a register");
  const principalId = principalOfBond(box.ergoTree);
  if (box.ergoTree !== bondContract(principalId)) throw new Error("not a SigmaFi bond");
  const maturity = Number(SConstant.from<number>(r.R7).data);
  return {
    boxId: box.boxId,
    principalId,
    principal: 0n, // not kept in the bond; the repayment is
    repayment: BigInt(SConstant.from<bigint>(r.R6).data),
    term: maturity,
    maturity,
    borrower: pk(r.R5),
    lender: pk(r.R8),
    collateralErg: BigInt(box.value) > SAFE_MIN_BOX_VALUE ? BigInt(box.value) : 0n,
    collateralTokens: box.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
  };
}

export const devFee = (principal: bigint) => (DEV_FEE_PER_100K * principal) / 100_000n;
export const uiFee = (principal: bigint) => (UI_FEE_PER_100K * principal) / 100_000n;

export interface OpenOrderParams {
  height: number;
  inputs: Box<Amount>[];
  borrower: ErgoAddress;
  principalId: string;
  principal: bigint;
  repayment: bigint;
  /** blocks, under the storage-rent period */
  term: number;
  collateralErg?: bigint;
  collateralTokens?: { tokenId: string; amount: bigint }[];
}

export function buildOpenOrder(p: OpenOrderParams): EIP12UnsignedTransaction {
  if (p.term >= STORAGE_PERIOD) throw new Error(`the term must be under ${STORAGE_PERIOD} blocks`);
  if (p.repayment < p.principal) throw new Error("the repayment must cover the principal");
  const value = p.collateralErg && p.collateralErg > 0n ? p.collateralErg : SAFE_MIN_BOX_VALUE;
  const out = new OutputBuilder(value, orderContract(p.principalId))
    .addTokens(p.collateralTokens ?? [])
    .setAdditionalRegisters({
      R4: SSigmaProp(SGroupElement(p.borrower.getPublicKeys()[0])).toHex(),
      R5: SLong(p.principal).toHex(),
      R6: SLong(p.repayment).toHex(),
      R7: SInt(p.term).toHex(),
    });
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .to(out)
    .sendChangeTo(p.borrower)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export function buildCancelOrder(p: {
  height: number;
  inputs: Box<Amount>[];
  borrower: ErgoAddress;
  orderBox: Box<Amount>;
}): EIP12UnsignedTransaction {
  const o = describeOrder(p.orderBox);
  if (o.borrower !== p.borrower.encode()) throw new Error("only the borrower can cancel");
  const back = new OutputBuilder(BigInt(p.orderBox.value), p.borrower).addTokens(p.orderBox.assets);
  return new TransactionBuilder(p.height)
    .from([p.orderBox, ...p.inputs])
    .to(back)
    .sendChangeTo(p.borrower)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/** The lender closes the order: the bond at output 0, the principal to the borrower, the developer fee, the "UI fee" back to the lender. */
export function buildLend(p: {
  height: number;
  inputs: Box<Amount>[];
  lender: ErgoAddress;
  orderBox: Box<Amount>;
}): EIP12UnsignedTransaction {
  const o = describeOrder(p.orderBox);
  const isErg = o.principalId === ERG;
  const lenderProp = SSigmaProp(SGroupElement(p.lender.getPublicKeys()[0])).toHex();
  const orderIn = new ErgoUnsignedInput(p.orderBox).setContextVars({ 0: lenderProp });
  const bond = new OutputBuilder(BigInt(p.orderBox.value), bondContract(o.principalId))
    .addTokens(p.orderBox.assets)
    .setAdditionalRegisters({
      R4: SColl(SByte, o.boxId).toHex(),
      R5: p.orderBox.additionalRegisters.R4 as string,
      R6: p.orderBox.additionalRegisters.R6 as string,
      R7: SInt(p.height + o.term).toHex(),
      R8: lenderProp,
    });
  const borrower = ErgoAddress.fromBase58(o.borrower);
  const loan = isErg
    ? new OutputBuilder(o.principal, borrower)
    : new OutputBuilder(SAFE_MIN_BOX_VALUE, borrower).addTokens({ tokenId: o.principalId, amount: o.principal });
  const dev = devFee(o.principal),
    ui = uiFee(o.principal);
  const devOut = isErg
    ? new OutputBuilder(dev, DEV_FEE_TREE)
    : new OutputBuilder(SAFE_MIN_BOX_VALUE, DEV_FEE_TREE).addTokens(
        dev > 0n ? [{ tokenId: o.principalId, amount: dev }] : [],
      );
  const uiOut = isErg
    ? new OutputBuilder(ui, p.lender)
    : new OutputBuilder(SAFE_MIN_BOX_VALUE, p.lender).addTokens(
        ui > 0n ? [{ tokenId: o.principalId, amount: ui }] : [],
      );
  return new TransactionBuilder(p.height)
    .from([orderIn, ...p.inputs])
    .to([bond, loan, devOut, uiOut])
    .sendChangeTo(p.lender)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/** The borrower repays: output 0 the repayment to the lender (R4 = bond id), output 1 the collateral back. */
export function buildRepay(p: {
  height: number;
  inputs: Box<Amount>[];
  borrower: ErgoAddress;
  bondBox: Box<Amount>;
}): EIP12UnsignedTransaction {
  const b = describeBond(p.bondBox);
  if (b.borrower !== p.borrower.encode()) throw new Error("only the borrower repays");
  const lender = ErgoAddress.fromBase58(b.lender);
  const repayment = (
    b.principalId === ERG
      ? new OutputBuilder(b.repayment, lender)
      : new OutputBuilder(SAFE_MIN_BOX_VALUE, lender).addTokens({ tokenId: b.principalId, amount: b.repayment })
  ).setAdditionalRegisters({ R4: SColl(SByte, b.boxId).toHex() });
  const collateral = new OutputBuilder(BigInt(p.bondBox.value), p.borrower).addTokens(p.bondBox.assets);
  return new TransactionBuilder(p.height)
    .from([p.bondBox, ...p.inputs])
    .to([repayment, collateral])
    .sendChangeTo(p.borrower)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/** After maturity: the collateral to the lender (R4 = bond id) at output 0. */
export function buildLiquidate(p: {
  height: number;
  inputs: Box<Amount>[];
  recipient: ErgoAddress;
  bondBox: Box<Amount>;
}): EIP12UnsignedTransaction {
  const b = describeBond(p.bondBox);
  if (p.height < b.maturity) throw new Error(`the bond matures at ${b.maturity}`);
  const lender = ErgoAddress.fromBase58(b.lender);
  const out = new OutputBuilder(BigInt(p.bondBox.value), lender)
    .addTokens(p.bondBox.assets)
    .setAdditionalRegisters({ R4: SColl(SByte, b.boxId).toHex() });
  return new TransactionBuilder(p.height)
    .from([p.bondBox, ...p.inputs])
    .to(out)
    .sendChangeTo(p.recipient)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}
