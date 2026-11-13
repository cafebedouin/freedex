// What a wallet library does with the Lithos transactions the page builds, under the recorded mainnet headers.
// ergo-lib-wasm 0.29 (the page's binding, sigma-rust 688511df) must parse every input's tree, reduce the
// transaction, stop signing only for lack of the key an input reduces to, and, when the synthetic owner IS the
// throwaway key, produce proofs its own verifier accepts. ergo-lib-wasm 0.28.0 (npm; Nautilus 1.4 ships its binary)
// is the negative control: it must fail at parse on every version-3 input. Synthetic boxes (rebuilt at the
// throwaway key's script, ids recomputed) exist only here; nothing is submitted anywhere.
import { describe, expect, it } from "vitest";
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import { hex } from "@fleet-sdk/crypto";
import lib29node from "ergo-lib-wasm-nodejs";
import lib28node from "ergo-lib-wasm-nodejs-028";
import { reduceTransaction, type ErgoLibModule } from "../src/ergopay";
import { buildCancel, describeOrder, orderTree, treeVersion } from "../src/protocols/lithos/lithos";

import {
  RECORD,
  rebuildClaim,
  rebuildPlacement,
  parseTree,
  proveDlog,
  reduce,
  rehome,
  sign,
  throwawayAddress,
  verifyAll,
  type Headers,
  type Lib,
} from "./lithos-record";

const lib29 = lib29node as unknown as Lib;
const lib28 = lib28node as unknown as Lib;
const THROWAWAY = throwawayAddress(lib29);
const THROWAWAY_PK = hex.encode(THROWAWAY.getPublicKeys()[0]);
const PARSE = /pars|deserializ|NonConsumed/i;
const v3 = (tx: EIP12UnsignedTransaction) => tx.inputs.filter((i) => treeVersion(i.ergoTree) >= 2);
const p2pkIndices = (tx: EIP12UnsignedTransaction) =>
  tx.inputs.flatMap((i, k) => (i.ergoTree.startsWith("0008cd") ? [k] : []));
/** The page's own reduction (src/ergopay.ts) takes the explorer's newest-first headers, the newest as pre-header. */
const pageHeaders = (h: Headers) => [h.blockHeader, ...h.lastHeaders].slice(0, 10);

const claimHeaders = (height: number) => RECORD.headers[String(height)];
const cancelHeaders = RECORD.headers[String(RECORD.cancelHeadersAt)];

/** A cancel of a recorded order: the order box, then the owner's boxes from its placing transaction to pay the fee. */
function cancelOf(o: (typeof RECORD.orders)[number]) {
  const v = describeOrder(o.box)!;
  const owner = ErgoAddress.fromPublicKey(v.terms.owner);
  return {
    v,
    owner,
    tx: buildCancel({ height: RECORD.cancelHeadersAt, inputs: o.placement.inputs, owner, orderBox: o.box }),
  };
}

/** The same cancel with the throwaway key as the order's owner and as the owner of the funding boxes. */
function syntheticCancelOf(o: (typeof RECORD.orders)[number]) {
  const v = describeOrder(o.box)!;
  const order = rehome(o.box, orderTree(v.kind, { ...v.terms, owner: THROWAWAY_PK }));
  const funding = o.placement.inputs.map((b) => rehome(b, THROWAWAY.ergoTree));
  return buildCancel({ height: RECORD.cancelHeadersAt, inputs: funding, owner: THROWAWAY, orderBox: order });
}

describe("ergo-lib-wasm 0.29: the page's claims under the recorded headers", () => {
  it.each(RECORD.claims.map((c) => [c.txId.slice(0, 8), c] as const))("claim %s", (_id, c) => {
    const h = claimHeaders(c.inclusionHeight);
    const { n, tx } = rebuildClaim(c);
    for (const i of tx.inputs) expect(parseTree(lib29, i.ergoTree), i.boxId).toEqual({ ok: true });
    const r = reduce(lib29, tx, h);
    expect(r.err).toBeUndefined();
    // the vault and the provisions reduce to true; the wallet's boxes to the wallet's key
    const wallet = c.inputBoxes[1 + n];
    expect(r.props![1 + n]).toBe(proveDlog(wallet.ergoTree.slice(6)));
    for (let i = 0; i <= n; i++) expect(r.props![i]).toBe(r.props![0]);
    expect(r.props![0]).not.toBe(r.props![1 + n]);
    // the page's own reduction path agrees
    expect(reduceTransaction(lib29 as unknown as ErgoLibModule, tx, pageHeaders(h)).txId).toMatch(/^[0-9a-f]{64}$/);
    // signing stops only at a wallet input, for lack of its key
    const s = sign(lib29, tx, h);
    expect(s.signed).toBeUndefined();
    expect(s.err).not.toMatch(PARSE);
    expect(p2pkIndices(tx)).toContain(s.index);
    // the claimant is the throwaway key: every proof verifies
    const synthetic = rebuildClaim(c, {
      inputs: c.inputBoxes.slice(1 + n).map((b) => rehome(b, THROWAWAY.ergoTree)),
      owner: THROWAWAY,
    }).tx;
    const ok = sign(lib29, synthetic, h);
    expect(ok.err).toBeUndefined();
    expect(verifyAll(lib29, synthetic, ok.signed!, h).every(Boolean)).toBe(true);
  });
});

describe("ergo-lib-wasm 0.29: the page's cancels of every recorded order", () => {
  it.each(RECORD.orders.map((o, i) => [i, o.kind, o] as const))("order %i (%s)", (_i, _k, o) => {
    const { v, tx } = cancelOf(o);
    const at = tx.inputs.findIndex((i) => i.boxId === o.box.boxId);
    expect(at).toBe(0);
    expect(parseTree(lib29, o.box.ergoTree)).toEqual({ ok: true });
    const r = reduce(lib29, tx, cancelHeaders);
    expect(r.err).toBeUndefined();
    // the refund path: the order reduces to its owner's key and nothing else
    expect(r.props![0]).toBe(proveDlog(v.terms.owner));
    expect(reduceTransaction(lib29 as unknown as ErgoLibModule, tx, pageHeaders(cancelHeaders)).txId).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const s = sign(lib29, tx, cancelHeaders);
    expect(s.signed).toBeUndefined();
    expect(s.err).not.toMatch(PARSE);
    expect(s.err).toMatch(/not have enough witnesses|witness|secret/i);
    expect(s.index).toBe(0);
    const synthetic = syntheticCancelOf(o);
    const ok = sign(lib29, synthetic, cancelHeaders);
    expect(ok.err).toBeUndefined();
    expect(verifyAll(lib29, synthetic, ok.signed!, cancelHeaders).every(Boolean)).toBe(true);
  });
});

describe("placing an order needs no version-3 parse: both builds sign it", () => {
  it.each(RECORD.orders.map((o, i) => [i, o.kind, o] as const))("order %i (%s)", (_i, _k, o) => {
    const tx = rebuildPlacement(o);
    const h = cancelHeaders;
    expect(v3(tx)).toEqual([]);
    for (const lib of [lib29, lib28]) {
      expect(reduce(lib, tx, h).err).toBeUndefined();
      const s = sign(lib, tx, h);
      expect(s.err).not.toMatch(PARSE);
      expect(p2pkIndices(tx)).toContain(s.index);
      const synthetic = rebuildPlacement(
        o,
        o.placement.inputs.map((b) => rehome(b, THROWAWAY.ergoTree)),
      );
      // the synthetic owner differs, so the order box's tree differs from the record; the shape is the same
      const ok = sign(lib, synthetic, h);
      expect(ok.err).toBeUndefined();
      expect(verifyAll(lib, synthetic, ok.signed!, h).every(Boolean)).toBe(true);
    }
  });
});

describe("negative control: ergo-lib-wasm 0.28.0 fails at parse on every version-3 input", () => {
  it("every claim and every cancel", () => {
    let v3Inputs = 0;
    let txs = 0;
    const all: [EIP12UnsignedTransaction, Headers][] = [
      ...RECORD.claims.map(
        (c) => [rebuildClaim(c).tx, claimHeaders(c.inclusionHeight)] as [EIP12UnsignedTransaction, Headers],
      ),
      ...RECORD.orders.map((o) => [cancelOf(o).tx, cancelHeaders] as [EIP12UnsignedTransaction, Headers]),
    ];
    for (const [tx, h] of all) {
      txs++;
      for (const i of v3(tx)) {
        v3Inputs++;
        const p = parseTree(lib28, i.ergoTree);
        expect(p.ok).toBe(false);
        expect(p.err).toMatch(/NonConsumedBytes/);
        expect(parseTree(lib29, i.ergoTree).ok).toBe(true);
      }
      const r = reduce(lib28, tx, h);
      expect(r.ok).toBe(false);
      expect(r.err).toMatch(PARSE);
      expect(() => reduceTransaction(lib28 as unknown as ErgoLibModule, tx, pageHeaders(h))).toThrow(PARSE);
    }
    expect(txs).toBe(71);
    // 20 claims: a vault and 1 provision each (16 claims) or more; 51 cancels: one order each
    expect(v3Inputs).toBe(RECORD.claims.reduce((s, c) => s + 1 + rebuildClaim(c).n, 0) + 51);
  });
});

// the counts this file stands on, printed for the record of the run
describe("summary", () => {
  it("prints the counts", () => {
    const claimV3 = RECORD.claims.reduce((s, c) => s + 1 + rebuildClaim(c).n, 0);
    const kinds = RECORD.orders.reduce<Record<string, number>>(
      (m, o) => ({ ...m, [o.kind]: (m[o.kind] ?? 0) + 1 }),
      {},
    );
    console.log(
      `lithos-lib: ${RECORD.claims.length} claims (${claimV3} v3 inputs), ${RECORD.orders.length} cancels and placements ${JSON.stringify(kinds)}`,
    );
    expect(Object.values(kinds).reduce((a, b) => a + b, 0)).toBe(51);
  });
});

export type { Box };
