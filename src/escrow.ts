// TokenJay's escrow contract (tokenjay.app/escrow.html, deployed at the P2S address beginning DaJygexrs8…): a
// seller locks one token kind for one named buyer at an ERG price; the buyer pays, or the seller cancels. The
// script demands a "UI fee" output of at least 0.001 ERG to the address in R7; the page points R7 at the seller, so
// the fee comes back to them and the escrow costs nothing but the miner fee.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import { hex } from "@fleet-sdk/crypto";
import { SByte, SColl, SConstant, SLong } from "@fleet-sdk/serializer";
import { FEE } from "./orders.ts";

/** The deployed tree, read from the explorer (46 boxes all time, 2026-10-29). */
export const ESCROW_TREE =
  "100a0400040005d00f0580897a040404020400040004020400d809d601b2a5730000d602db63087201d603b2db6308a7730100d604e4c6a7040ed60593c272017204d606e4c6a70505d607a29d9c7206e4c6a7060573027303d608b2a5730400d609b2a5730500d1ecededededed91b17202730693b272027307007203720593e4c67201040ec5a793c2b2a4730800720492c17201c1a7edededededed720592c17201997206720793c27208e4c6a7070e92c17208720793e4c67201040ec5a793b2db63087209730900720393c27209e4c6a7080e";

export interface EscrowView {
  boxId: string;
  seller: string;
  buyer: string;
  /** nanoERG the buyer pays */
  price: bigint;
  tokenId: string;
  amount: bigint;
  /** per-thousand "UI fee" rate in R6; the fee box must hold max(price * rate / 1000, 0.001 ERG) */
  feeRate: bigint;
  feeTree: string;
  value: bigint;
}

/** a Coll[Byte] register holding an ErgoTree, as hex */
const treeHex = (hexColl: string) => hex.encode(SConstant.from<Uint8Array>(hexColl).data);
const addr = (hexColl: string) => ErgoAddress.fromErgoTree(treeHex(hexColl)).encode();

export function describeEscrow(box: Box<Amount>): EscrowView {
  if (box.ergoTree !== ESCROW_TREE) throw new Error("not a TokenJay escrow box");
  const r = box.additionalRegisters;
  if (!r.R4 || !r.R5 || !r.R6 || !r.R7 || !r.R8) throw new Error("escrow box lacks a register");
  if (!box.assets[0]) throw new Error("escrow box holds no token");
  return {
    boxId: box.boxId,
    seller: addr(r.R4),
    buyer: addr(r.R8),
    price: BigInt(SConstant.from<bigint>(r.R5).data),
    tokenId: box.assets[0].tokenId,
    amount: BigInt(box.assets[0].amount),
    feeRate: BigInt(SConstant.from<bigint>(r.R6).data),
    feeTree: treeHex(r.R7),
    value: BigInt(box.value),
  };
}

export function escrowFee(price: bigint, feeRate: bigint): bigint {
  const f = (price * feeRate) / 1000n;
  return f > 1_000_000n ? f : 1_000_000n;
}

export interface CreateEscrowParams {
  height: number;
  inputs: Box<Amount>[];
  seller: ErgoAddress;
  buyer: ErgoAddress;
  tokenId: string;
  amount: bigint;
  price: bigint;
}

/** The seller locks the tokens for the buyer. R6 = 0 and R7 = the seller, so the contract's fee returns to the seller. */
export function buildCreateEscrow(p: CreateEscrowParams): EIP12UnsignedTransaction {
  const coll = (hexTree: string) => SColl(SByte, hexTree).toHex();
  const out = new OutputBuilder(1_000_000n, ESCROW_TREE)
    .addTokens({ tokenId: p.tokenId, amount: p.amount })
    .setAdditionalRegisters({
      R4: coll(p.seller.ergoTree),
      R5: SLong(p.price).toHex(),
      R6: SLong(0n).toHex(),
      R7: coll(p.seller.ergoTree),
      R8: coll(p.buyer.ergoTree),
    });
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .to(out)
    .sendChangeTo(p.seller)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface TakeEscrowParams {
  height: number;
  inputs: Box<Amount>[];
  buyer: ErgoAddress;
  escrowBox: Box<Amount>;
}

/** The named buyer pays: output 0 the price minus fee to the seller (R4 = escrow id), 1 the tokens to the buyer, 2 the fee box. */
export function buildTakeEscrow(p: TakeEscrowParams): EIP12UnsignedTransaction {
  const e = describeEscrow(p.escrowBox);
  if (p.buyer.encode() !== e.buyer) throw new Error("only the named buyer can take this escrow");
  const fee = escrowFee(e.price, e.feeRate);
  const pay = new OutputBuilder(
    e.price - fee,
    ErgoAddress.fromErgoTree(treeHex(p.escrowBox.additionalRegisters.R4 as string)),
  ).setAdditionalRegisters({ R4: SColl(SByte, e.boxId).toHex() });
  const buy = new OutputBuilder(1_000_000n, p.buyer).addTokens({ tokenId: e.tokenId, amount: e.amount });
  const feeBox = new OutputBuilder(fee, e.feeTree);
  return new TransactionBuilder(p.height)
    .from([p.escrowBox, ...p.inputs])
    .to([pay, buy, feeBox])
    .sendChangeTo(p.buyer)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface CancelEscrowParams {
  height: number;
  /** must include at least one of the seller's own boxes as the second input (the script checks INPUTS(1)) */
  inputs: Box<Amount>[];
  seller: ErgoAddress;
  escrowBox: Box<Amount>;
}

export function buildCancelEscrow(p: CancelEscrowParams): EIP12UnsignedTransaction {
  const e = describeEscrow(p.escrowBox);
  if (p.seller.encode() !== e.seller) throw new Error("only the seller can cancel");
  const sellerBox = p.inputs.find((b) => b.ergoTree === p.seller.ergoTree);
  if (!sellerBox) throw new Error("the cancel needs one of the seller's boxes as the second input");
  const refund = new OutputBuilder(e.value, p.seller)
    .addTokens({ tokenId: e.tokenId, amount: e.amount })
    .setAdditionalRegisters({ R4: SColl(SByte, e.boxId).toHex() });
  return new TransactionBuilder(p.height)
    .from([p.escrowBox, sellerBox, ...p.inputs.filter((b) => b.boxId !== sellerBox.boxId)])
    .configureSelector((s) => s.ensureInclusion([p.escrowBox.boxId, sellerBox.boxId]))
    .to(refund)
    .sendChangeTo(p.seller)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}
