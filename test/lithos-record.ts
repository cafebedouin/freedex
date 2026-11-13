// The recorded LithosDex transactions (test/fixtures/lithos-record.json, scripts/lithos-fixtures.ts) and the steps
// the library checks run on a built transaction, for either ergo-lib-wasm build (0.29, the page's; 0.28.0, the
// negative control). Not a test file: the Lithos tests import it.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, ErgoBox } from "@fleet-sdk/core";
import {
  buildClaim,
  buildDepositOrder,
  buildRedeemOrder,
  buildSwapOrder,
  describeOrder,
} from "../src/protocols/lithos/lithos.ts";
import { hex } from "@fleet-sdk/crypto";
import type * as Lib29 from "ergo-lib-wasm-nodejs";
import { parseExact } from "../src/explorer.ts";
import recordText from "./fixtures/lithos-record.json?raw";

export type Lib = typeof Lib29;

type NodeBox = Box<bigint> & { transactionId: string; index: number };
export interface Headers {
  blockHeader: unknown;
  lastHeaders: unknown[];
}
export interface RecordedClaim {
  txId: string;
  inclusionHeight: number;
  tx: {
    inputs: { boxId: string; spendingProof: { proofBytes: string; extension: Record<string, string> } }[];
    outputs: NodeBox[];
  };
  inputBoxes: NodeBox[];
}
export interface RecordedOrder {
  kind: string;
  box: NodeBox;
  executedIn: string;
  provisionBox?: NodeBox;
  placement: { txId: string; inclusionHeight: number; inputs: NodeBox[]; outputs: NodeBox[] };
}
export interface LithosRecord {
  cancelHeadersAt: number;
  poolBox: NodeBox;
  headers: { [height: string]: Headers };
  claims: RecordedClaim[];
  orders: RecordedOrder[];
}

export const RECORD = parseExact(recordText) as unknown as LithosRecord;

/** The fee contract's tree (miner fee outputs). */
export const FEE_TREE =
  "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304";

/** The throwaway key of the checks: the scalar 0x01..01, as the v3 signing corpus runs use. Never a real wallet. */
export const THROWAWAY_SECRET = new Uint8Array(32).fill(1);

export function throwawayAddress(lib: Lib): ErgoAddress {
  const sk = lib.SecretKey.dlog_from_bytes(THROWAWAY_SECRET);
  return ErgoAddress.fromBase58(sk.get_address().to_base58(lib.NetworkPrefix.Mainnet));
}

/** A copy of a box at another script, with its id recomputed (a synthetic box: never submitted anywhere). */
export function rehome(box: Box<Amount>, ergoTree: string): Box<bigint> {
  const b = new ErgoBox(
    {
      value: BigInt(box.value),
      ergoTree,
      creationHeight: box.creationHeight,
      assets: box.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
      additionalRegisters: box.additionalRegisters,
    },
    box.transactionId,
    box.index,
  );
  return {
    boxId: b.boxId,
    transactionId: b.transactionId,
    index: b.index,
    value: b.value,
    ergoTree: b.ergoTree,
    creationHeight: b.creationHeight,
    assets: b.assets,
    additionalRegisters: b.additionalRegisters,
  };
}

/** The state context the node validated the recorded block in: its header as the pre-header, the ten before it. */
export function stateContext(lib: Lib, h: Headers) {
  const hdrs = lib.BlockHeaders.from_json(h.lastHeaders as unknown[]);
  const pre = lib.PreHeader.from_block_header(lib.BlockHeader.from_json(JSON.stringify(h.blockHeader)));
  return new lib.ErgoStateContext(pre, hdrs, lib.Parameters.default_parameters());
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Step a: the tree parses, its bytes round-trip, and its root expression parsed (template_bytes needs it). */
export function parseTree(lib: Lib, tree: string): { ok: boolean; err?: string } {
  try {
    const t = lib.ErgoTree.from_base16_bytes(tree);
    if (t.to_base16_bytes() !== tree) return { ok: false, err: "bytes differ after the round trip" };
    t.template_bytes();
    return { ok: true };
  } catch (e) {
    return { ok: false, err: errText(e) };
  }
}

function libTx(lib: Lib, tx: EIP12UnsignedTransaction) {
  const unsigned = lib.UnsignedTransaction.from_json(JSON.stringify(tx, big));
  const boxes = lib.ErgoBoxes.from_boxes_json(JSON.parse(JSON.stringify(tx.inputs, big)));
  const data = lib.ErgoBoxes.from_boxes_json(JSON.parse(JSON.stringify(tx.dataInputs, big)));
  return { unsigned, boxes, data };
}

/** Step c: the reduction, and per input the reduced proposition as the library's JSON gives it. */
export function reduce(
  lib: Lib,
  tx: EIP12UnsignedTransaction,
  h: Headers,
): { ok: boolean; err?: string; props?: string[] } {
  try {
    const { unsigned, boxes, data } = libTx(lib, tx);
    const r = lib.ReducedTransaction.from_unsigned_tx(unsigned, boxes, data, stateContext(lib, h));
    let props: string[] | undefined;
    if (typeof (r as { to_json?: () => string }).to_json === "function") {
      const j = JSON.parse(r.to_json()) as { reducedInputs?: { sigmaProp: string }[] };
      props = j.reducedInputs?.map((x) => x.sigmaProp);
    }
    return { ok: true, props };
  } catch (e) {
    return { ok: false, err: errText(e) };
  }
}

/** Step d: signing with one secret. Either a signed transaction, or the error and the input index it names. */
export function sign(
  lib: Lib,
  tx: EIP12UnsignedTransaction,
  h: Headers,
  secret = THROWAWAY_SECRET,
): { signed?: InstanceType<Lib["Transaction"]>; err?: string; index?: number } {
  try {
    const { unsigned, boxes, data } = libTx(lib, tx);
    const sks = new lib.SecretKeys();
    sks.add(lib.SecretKey.dlog_from_bytes(secret));
    const signed = lib.Wallet.from_secrets(sks).sign_transaction(stateContext(lib, h), unsigned, boxes, data);
    return { signed };
  } catch (e) {
    const err = errText(e);
    const m = /input index:?\s*(\d+)/i.exec(err) ?? /index[^0-9]{0,8}(\d+)/i.exec(err);
    return { err, index: m ? Number(m[1]) : undefined };
  }
}

/** The library's own verifier over every input of a signed transaction. */
export function verifyAll(
  lib: Lib,
  tx: EIP12UnsignedTransaction,
  signed: InstanceType<Lib["Transaction"]>,
  h: Headers,
) {
  const { boxes, data } = libTx(lib, tx);
  const ctx = stateContext(lib, h);
  return tx.inputs.map((_, i) => lib.verify_tx_input_proof(i, ctx, signed, boxes, data));
}

/** The serialized ProveDlog proposition of a public key (what a single-key input reduces to). */
export const proveDlog = (pk: Uint8Array | string) => `cd${typeof pk === "string" ? pk : hex.encode(pk)}`;

const addr = (pk: string) => ErgoAddress.fromPublicKey(pk);

/** The builder call that places `o`, from the terms its box carries and the inputs its placing transaction spent. */
export function rebuildPlacement(o: RecordedOrder, inputs: Box<Amount>[] = o.placement.inputs) {
  const v = describeOrder(o.box)!;
  const t = v.terms;
  const common = {
    height: o.box.creationHeight,
    inputs,
    owner: addr(t.owner),
    executorFee: t.executorFee,
    maxMinerFee: t.maxMinerFee,
  };
  switch (v.kind) {
    case "swap-sell":
      return buildSwapOrder({
        ...common,
        poolBox: RECORD.poolBox,
        direction: "erg-to-lit",
        amountIn: t.baseAmount!,
        minOut: t.minQuote!,
      });
    case "swap-buy":
      return buildSwapOrder({
        ...common,
        poolBox: RECORD.poolBox,
        direction: "lit-to-erg",
        amountIn: v.token!.amount,
        minOut: t.minQuote!,
      });
    case "deposit":
      return buildDepositOrder({
        ...common,
        poolBox: RECORD.poolBox,
        amountX: t.depositX!,
        amountY: v.token!.amount,
        minShares: t.minShares!,
      });
    case "redeem":
      return buildRedeemOrder({ ...common, provisionBox: o.provisionBox! });
  }
}

/** The claim that `c` made, rebuilt from its inputs: vault, provisions (count from the vault's variable 1), wallet. */
export function rebuildClaim(c: RecordedClaim, override?: { inputs?: Box<Amount>[]; owner?: ErgoAddress }) {
  const n = Number.parseInt(c.tx.inputs[0].spendingProof.extension["1"].slice(2), 16) / 2; // SInt, zigzag
  const wallet = c.inputBoxes.slice(1 + n);
  return {
    n,
    tx: buildClaim({
      height: c.tx.outputs[0].creationHeight,
      inputs: override?.inputs ?? wallet,
      owner: override?.owner ?? ErgoAddress.fromErgoTree(wallet[0].ergoTree),
      vaultBox: c.inputBoxes[0],
      provisionBoxes: c.inputBoxes.slice(1, 1 + n),
    }),
  };
}
