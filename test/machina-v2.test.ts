// Machina's ErgoTree version 2 limit order (src/protocols/machina/orders.ts, E2T_V2) against recorded mainnet spends
// (test/fixtures/machina-v2-record.json): the page reads every recorded version-2 order, its fill builds the same
// successor box the recorded fills made, and its fill and close pass the library checks under the recorded headers
// with ergo-lib-wasm 0.29, while 0.28.0 fails at parse on the version-2 tree. Synthetic boxes (the throwaway key's)
// exist only here.
import { describe, expect, it } from "vitest";
import type { Amount, Box } from "@fleet-sdk/common";
import { ErgoAddress, ErgoBox } from "@fleet-sdk/core";
import { hex } from "@fleet-sdk/crypto";
import { SConstant, SGroupElement, SSigmaProp } from "@fleet-sdk/serializer";
import lib29node from "ergo-lib-wasm-nodejs";
import lib28node from "ergo-lib-wasm-nodejs-028";
import { parseExact } from "../src/explorer";
import { E2T_V2, buildClose, buildCreate, buildFill, describe as describeOrder } from "../src/protocols/machina/orders";
import {
  parseTree,
  proveDlog,
  reduce,
  sign,
  throwawayAddress,
  verifyAll,
  type Headers,
  type Lib,
} from "./lithos-record";
import text from "./fixtures/machina-v2-record.json?raw";

type NodeBox = Box<bigint> & { transactionId: string; index: number };
interface Tx {
  txId: string;
  inclusionHeight: number;
  tx: {
    inputs: { boxId: string; spendingProof: { proofBytes: string; extension: Record<string, string> } }[];
    outputs: NodeBox[];
  };
  inputBoxes: NodeBox[];
  blockHeader: unknown;
  lastHeaders: unknown[];
}
const REC = parseExact(text) as unknown as { txs: Tx[] };
const lib29 = lib29node as unknown as Lib;
const lib28 = lib28node as unknown as Lib;
const ME = throwawayAddress(lib29);
const PARSE = /pars|deserializ|NonConsumed/i;
const headersOf = (t: Tx): Headers => ({ blockHeader: t.blockHeader, lastHeaders: t.lastHeaders });

/** A synthetic box from a candidate (id computed). */
function synth(
  c: {
    value: bigint;
    ergoTree: string;
    creationHeight: number;
    assets?: { tokenId: string; amount: bigint }[];
    additionalRegisters?: Record<string, string>;
  },
  n = 0,
): Box<bigint> {
  const b = new ErgoBox(
    {
      value: c.value,
      ergoTree: c.ergoTree,
      creationHeight: c.creationHeight,
      assets: c.assets ?? [],
      additionalRegisters: c.additionalRegisters ?? {},
    },
    "11".repeat(32),
    n,
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

const v2Inputs = REC.txs.flatMap((t) =>
  t.inputBoxes.flatMap((b, i) =>
    E2T_V2.validate(b.ergoTree) ? [{ t, b, i, ext: t.tx.inputs[i].spendingProof.extension }] : [],
  ),
);
const fills = v2Inputs.filter((x) => x.ext["0"] !== undefined);
const closes = v2Inputs.filter(
  (x) => x.ext["0"] === undefined && x.t.tx.inputs[x.i].spendingProof.proofBytes.length > 0,
);

describe("the record: Machina version-2 limit orders", () => {
  it("reads every recorded version-2 limit order (54), and the SDK's own tree is not version 2", () => {
    expect(v2Inputs.length).toBe(54);
    for (const { b } of v2Inputs) expect(describeOrder(b).tokenId).toBe(E2T_V2.getQuoteId(b.ergoTree));
    expect(fills.length + closes.length).toBe(54);
    const v1 = buildCreate({
      height: 1,
      inputs: [synth({ value: 10_000_000_000n, ergoTree: ME.ergoTree, creationHeight: 1 })],
      owner: ME,
      side: "buy-tokens",
      quoteTokenId: "ab".repeat(32),
      price: 1000n,
      ergAmount: 10_000_000n,
    });
    expect(v1.outputs[0].ergoTree.slice(0, 2)).toBe("19");
    expect(E2T_V2.validate(v1.outputs[0].ergoTree)).toBe(false);
  });
});

describe("a fill: the page's successor is the recorded one, and 0.29 signs it", () => {
  it.each(fills.map((x) => [x.t.txId.slice(0, 8), x] as const))("fill in %s", (_id, { t, b, ext }) => {
    const k = Number.parseInt(ext["0"].slice(2), 16) / 2; // SInt zigzag
    const rec = t.tx.outputs[k];
    const v = describeOrder(b);
    const held = b.assets[0]?.amount ?? 0n;
    const recHeld = rec.ergoTree === b.ergoTree ? (rec.assets[0]?.amount ?? 0n) : 0n;
    const outTokens = rec.assets.find((a) => a.tokenId === v.tokenId)?.amount ?? 0n;
    const amount = v.takerAction === "buy" ? held - recHeld : outTokens - held;
    expect(amount).toBeGreaterThan(0n);
    const funding = synth({
      value: 100_000_000_000n,
      ergoTree: ME.ergoTree,
      creationHeight: rec.creationHeight,
      assets: v.takerAction === "sell" ? [{ tokenId: v.tokenId, amount }] : [],
    });
    const tx = buildFill({
      height: rec.creationHeight,
      inputs: [funding],
      taker: ME,
      orderBox: b,
      tokenAmount: amount,
    });
    const out = tx.outputs.find(
      (o) => o.additionalRegisters.R7?.endsWith(b.boxId) || o.additionalRegisters.R4?.endsWith(b.boxId),
    )!;
    expect(out.ergoTree).toBe(rec.ergoTree);
    expect(BigInt(out.value)).toBe(rec.value);
    expect(out.assets.map((a) => [a.tokenId, BigInt(a.amount)])).toEqual(rec.assets.map((a) => [a.tokenId, a.amount]));
    expect(out.additionalRegisters).toEqual(rec.additionalRegisters);
    // the library: 0.29 parses and reduces (the order's fill path is keyless), signs with the taker's key, verifies
    const h = headersOf(t);
    expect(parseTree(lib29, b.ergoTree)).toEqual({ ok: true });
    const r = reduce(lib29, tx, h);
    expect(r.err).toBeUndefined();
    expect(r.props![tx.inputs.findIndex((i) => i.boxId === b.boxId)]).toBe("d3");
    const s = sign(lib29, tx, h);
    expect(s.err).toBeUndefined();
    expect(verifyAll(lib29, tx, s.signed!, h).every(Boolean)).toBe(true);
    // 0.28.0: the version-2 tree does not parse
    expect(parseTree(lib28, b.ergoTree).err).toMatch(/NonConsumedBytes/);
    expect(reduce(lib28, tx, h).err).toMatch(PARSE);
  });
});

describe("an owner's close: the order reduces to the owner's key", () => {
  it.each(closes.map((x) => [x.t.txId.slice(0, 8), x.b.boxId.slice(0, 8), x] as const))(
    "close in %s of %s",
    (_id, _b, { t, b }) => {
      const h = headersOf(t);
      const ownerPk = hex.encode(SConstant.from<Uint8Array>(b.additionalRegisters.R4!).data);
      const owner = ErgoAddress.fromPublicKey(ownerPk);
      const funding = synth({ value: 10_000_000n, ergoTree: owner.ergoTree, creationHeight: b.creationHeight });
      const tx = buildClose({
        height: t.blockHeader ? b.creationHeight + 1 : 1,
        inputs: [funding],
        owner,
        orderBox: b,
      });
      const at = tx.inputs.findIndex((i) => i.boxId === b.boxId);
      // the recorded close sent the order's tokens to its owner; so does the page's (in its change)
      const back = tx.outputs.filter((o) => o.ergoTree === owner.ergoTree).flatMap((o) => o.assets);
      for (const a of b.assets)
        expect(back.some((x) => x.tokenId === a.tokenId && BigInt(x.amount) >= a.amount)).toBe(true);
      expect(t.tx.outputs.some((o) => o.ergoTree === owner.ergoTree)).toBe(true);
      const r = reduce(lib29, tx, h);
      expect(r.err).toBeUndefined();
      expect(r.props![at]).toBe(proveDlog(ownerPk));
      const s = sign(lib29, tx, h);
      expect(s.err).not.toMatch(PARSE);
      expect(s.index).toBe(at);
      // the same order owned by the throwaway key: signed and verified
      const mine = synth(
        {
          value: b.value,
          ergoTree: b.ergoTree,
          creationHeight: b.creationHeight,
          assets: b.assets,
          additionalRegisters: {
            ...b.additionalRegisters,
            R4: SSigmaProp(SGroupElement(ME.getPublicKeys()[0])).toHex(),
          },
        },
        1,
      );
      const f2 = synth({ value: 10_000_000n, ergoTree: ME.ergoTree, creationHeight: b.creationHeight }, 2);
      const tx2 = buildClose({ height: b.creationHeight + 1, inputs: [f2], owner: ME, orderBox: mine as Box<Amount> });
      const ok = sign(lib29, tx2, h);
      expect(ok.err).toBeUndefined();
      expect(verifyAll(lib29, tx2, ok.signed!, h).every(Boolean)).toBe(true);
      expect(reduce(lib28, tx, h).err).toMatch(PARSE);
    },
  );
});

describe("placing a version-2 order", () => {
  it("builds Machina's live tree for the token, which the version-2 contract reads back", () => {
    const tokenId = "6c35aa395c7c75b0f67f7804d6930f0e11ef93c3387dc1faa86498d54af7962c";
    const tx = buildCreate({
      height: 1_915_000,
      inputs: [synth({ value: 10_000_000_000n, ergoTree: ME.ergoTree, creationHeight: 1 })],
      owner: ME,
      side: "buy-tokens",
      quoteTokenId: tokenId,
      price: 66n,
      ergAmount: 7_510_241n,
      treeVersion: 2,
    });
    const recorded = v2Inputs.find((x) => E2T_V2.getQuoteId(x.b.ergoTree) === tokenId)!.b;
    expect(tx.outputs[0].ergoTree).toBe(recorded.ergoTree);
    expect(
      describeOrder({ ...tx.outputs[0], boxId: "00".repeat(32), transactionId: "00".repeat(32), index: 0 }).owner,
    ).toBe(ME.encode());
  });
});
