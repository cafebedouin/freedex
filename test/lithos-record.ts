// The recorded LithosDex transactions (test/fixtures/lithos-record.json, scripts/lithos-fixtures.ts) and the steps
// the library checks run on a built transaction, for either ergo-lib-wasm build (0.29, the page's; 0.28.0, the
// negative control). Not a test file: the Lithos tests import it.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, ErgoBox } from "@fleet-sdk/core";
import {
  POOL_TREE,
  buildClaim,
  buildDeposit,
  buildDepositOrder,
  buildFlush,
  buildRedeem,
  buildRedeemOrder,
  buildResize,
  buildSwap,
  buildSwapOrder,
  describeOrder,
  describeProvision,
} from "../src/protocols/lithos/lithos.ts";
import { hex } from "@fleet-sdk/crypto";
import type * as Lib29 from "ergo-lib-wasm-nodejs";
import { parseExact } from "../src/explorer.ts";
import recordText from "./fixtures/lithos-record.json?raw";
import poolRecordText from "./fixtures/lithos-pool-record.json?raw";

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

// ---- the recorded pool transactions (test/fixtures/lithos-pool-record.json, scripts/lithos-pool-fixtures.ts) ----

export type PoolKind = "swap" | "deposit" | "redeem" | "flush" | "resize";
export interface RecordedPoolTx {
  txId: string;
  inclusionHeight: number;
  kind: PoolKind;
  /** every input but the pool (and, on a redeem, a resize or a flush, the provision and vault) is a P2PK box */
  direct: boolean;
  tx: { inputs: { boxId: string; extension: Record<string, string> }[]; outputs: NodeBox[] };
  inputBoxes: NodeBox[];
}
const POOL_KINDS: Record<string, PoolKind> = {
  "0200": "swap",
  "0201": "deposit",
  "0202": "redeem",
  "0203": "flush",
  "0204": "resize",
};

/** Puts the pool tree back where the fixture abbreviated it, and refuses any box whose id is not its bytes' hash. */
function restore(b: NodeBox): NodeBox {
  const box = { ...b, ergoTree: b.ergoTree === "POOL_TREE" ? POOL_TREE : b.ergoTree };
  const id = new ErgoBox(
    {
      value: BigInt(box.value),
      ergoTree: box.ergoTree,
      creationHeight: box.creationHeight,
      assets: box.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
      additionalRegisters: box.additionalRegisters,
    },
    box.transactionId,
    box.index,
  ).boxId;
  if (id !== box.boxId) throw new Error(`pool record: box ${box.boxId} does not hash to its id`);
  return box;
}

const poolRaw = parseExact(poolRecordText) as unknown as {
  headers: Record<string, Headers>;
  txs: Omit<RecordedPoolTx, "kind" | "direct">[];
};
export const POOL_RECORD = {
  headers: poolRaw.headers,
  txs: poolRaw.txs.map((t): RecordedPoolTx => {
    const inputBoxes = t.inputBoxes.map(restore);
    const kind = POOL_KINDS[t.tx.inputs[0].extension["0"]];
    if (!kind) throw new Error(`pool record: ${t.txId} has no pool operation`);
    const fixed = { swap: 1, deposit: 1, redeem: 2, flush: 2, resize: 3 }[kind];
    return {
      ...t,
      kind,
      direct: inputBoxes.slice(fixed).every((b) => b.ergoTree.startsWith("0008cd")),
      tx: { inputs: t.tx.inputs, outputs: t.tx.outputs.map(restore) },
      inputBoxes,
    };
  }),
};
export const poolOf = (kind: PoolKind) => POOL_RECORD.txs.filter((t) => t.kind === kind);

/** The funding of a rebuilt pool transaction: the recorded wallet boxes, or the order box re-homed at `owner`. */
function fundingOf(t: RecordedPoolTx, fixed: number, synthetic?: ErgoAddress) {
  const rest = t.inputBoxes.slice(fixed);
  if (!synthetic && t.direct)
    return { inputs: rest as Box<Amount>[], owner: ErgoAddress.fromErgoTree(rest[0].ergoTree) };
  const owner = synthetic;
  if (!owner) throw new Error(`${t.txId} was not made by a wallet: pass a synthetic owner`);
  return { inputs: rest.map((b) => rehome(b, owner.ergoTree)), owner };
}

/** A recorded box's height: the builders stamp every output with the height they are given, as the client did. */
const heightOf = (t: RecordedPoolTx) => t.tx.outputs[0].creationHeight;

/**
 * The builder call that makes `t` again. A wallet-made transaction is rebuilt from its own wallet boxes; an executed
 * order (or a flush with no wallet input) only with `synthetic`, which re-homes the remaining inputs at that owner's
 * script so they can fund it. Amounts come from what the recorded outputs show: the shares a deposit opened, the
 * size a resize set, the amount a swap put in.
 */
export function rebuildPoolTx(t: RecordedPoolTx, synthetic?: ErgoAddress): EIP12UnsignedTransaction {
  const [pool, second, third] = t.inputBoxes;
  const out = t.tx.outputs;
  const height = heightOf(t);
  switch (t.kind) {
    case "swap": {
      const ergIn = BigInt(out[0].value) > BigInt(pool.value);
      const amountIn = ergIn
        ? BigInt(out[0].value) - BigInt(pool.value)
        : BigInt(out[0].assets[1].amount) - BigInt(pool.assets[1].amount);
      const direction = ergIn ? "erg-to-lit" : "lit-to-erg";
      return buildSwap({ height, poolBox: pool, direction, amountIn, minOut: 1n, ...fundingOf(t, 1, synthetic) });
    }
    case "deposit":
      return buildDeposit({
        height,
        poolBox: pool,
        shares: describeProvision(out[1]).shares,
        ...fundingOf(t, 1, synthetic),
      });
    case "redeem":
      return buildRedeem({ height, poolBox: pool, provisionBox: second, ...fundingOf(t, 2, synthetic) });
    case "flush": {
      const f = t.inputBoxes.length > 2 ? fundingOf(t, 2, synthetic) : undefined;
      const owner = f?.owner ?? synthetic;
      if (!owner) throw new Error(`${t.txId} spends no wallet box: pass a synthetic payer`);
      const inputs = f?.inputs ?? [syntheticFunding(owner, t)];
      return buildFlush({ height, poolBox: pool, vaultBox: second, inputs, owner });
    }
    case "resize":
      return buildResize({
        height,
        poolBox: pool,
        provisionBox: second,
        vaultBox: third,
        newShares: describeProvision(out[1]).shares,
        ...fundingOf(t, 3, synthetic),
      });
  }
}

/** A 0.01 ERG box at `owner`, standing in for a fee payer the record does not have (never submitted anywhere). */
export function syntheticFunding(owner: ErgoAddress, t: RecordedPoolTx): Box<bigint> {
  const b = new ErgoBox(
    { value: 10_000_000n, ergoTree: owner.ergoTree, creationHeight: heightOf(t), assets: [], additionalRegisters: {} },
    t.txId,
    0,
  );
  return {
    boxId: b.boxId,
    transactionId: b.transactionId,
    index: b.index,
    value: b.value,
    ergoTree: b.ergoTree,
    creationHeight: b.creationHeight,
    assets: [],
    additionalRegisters: {},
  };
}

/** A copy of a box at another script and creation height, its id recomputed (synthetic: never submitted anywhere). */
export function rehomeAt(box: Box<Amount>, ergoTree: string, creationHeight: number): Box<bigint> {
  return rehome({ ...box, creationHeight }, ergoTree);
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
