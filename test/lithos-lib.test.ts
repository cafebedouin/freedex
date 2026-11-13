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
import { SBigInt } from "@fleet-sdk/serializer";
import {
  HEIGHT_SLACK,
  REFRESH_AGE,
  buildCancel,
  buildRefresh,
  buildResize,
  describeOrder,
  describeProvision,
  orderTree,
  treeVersion,
} from "../src/protocols/lithos/lithos";

import {
  POOL_RECORD,
  RECORD,
  poolOf,
  rebuildClaim,
  rebuildPlacement,
  rebuildPoolTx,
  rehomeAt,
  syntheticFunding,
  type RecordedPoolTx,
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

// ---- the direct pool operations: the recorded pool transactions that have their block's headers ----

const TRUE = "d3"; // a keyless input whose script held: the reduced proposition is TrivialProp(true)
const FALSE = "d2";
const STRANGER = ErgoAddress.fromPublicKey("02" + "33".repeat(32));
const fixedOf = { swap: 1, deposit: 1, redeem: 2, flush: 2, resize: 3 } as const;
const withHeaders = POOL_RECORD.txs.filter((t) => POOL_RECORD.headers[String(t.inclusionHeight)]);
const poolHeaders = (t: RecordedPoolTx) => POOL_RECORD.headers[String(t.inclusionHeight)];
/** The rebuilt transaction as its recorded maker would sign it (a stranger's boxes for an executed order) */
const asRecorded = (t: RecordedPoolTx) =>
  rebuildPoolTx(t, t.direct && !(t.kind === "flush" && t.inputBoxes.length === 2) ? undefined : STRANGER);

describe("ergo-lib-wasm 0.29: the direct pool builders under the recorded headers", () => {
  it.each(withHeaders.map((t) => [t.kind, t.txId.slice(0, 8), t] as const))("%s %s", (_k, _id, t) => {
    const h = poolHeaders(t);
    const n = fixedOf[t.kind];
    const tx = asRecorded(t);
    for (const i of tx.inputs) expect(parseTree(lib29, i.ergoTree), i.boxId).toEqual({ ok: true });
    const r = reduce(lib29, tx, h);
    expect(r.err).toBeUndefined();
    // the pool (and the provision, the vault) hold no key: their scripts held, so each reduces to true
    for (let i = 0; i < n; i++) expect(r.props![i]).toBe(TRUE);
    for (let i = n; i < tx.inputs.length; i++) expect(r.props![i]).toBe(proveDlog(tx.inputs[i].ergoTree.slice(6)));
    expect(reduceTransaction(lib29 as unknown as ErgoLibModule, tx, pageHeaders(h)).txId).toMatch(/^[0-9a-f]{64}$/);
    // signing with another key stops only at a wallet input, for lack of its secret
    const s = sign(lib29, tx, h);
    expect(s.signed).toBeUndefined();
    expect(s.err).not.toMatch(PARSE);
    expect(p2pkIndices(tx)).toContain(s.index);
    // the same transaction made by the throwaway key signs, and the library's verifier accepts every input
    const synthetic = rebuildPoolTx(t, THROWAWAY);
    const ok = sign(lib29, synthetic, h);
    expect(ok.err).toBeUndefined();
    expect(verifyAll(lib29, synthetic, ok.signed!, h).every(Boolean)).toBe(true);
  });
});

describe("resize both ways, and the pool's checks bite: synthetic resizes from the recorded resize's state", () => {
  const t = poolOf("resize")[0];
  const h = poolHeaders(t);
  const [poolBox, provisionBox, vaultBox] = t.inputBoxes;
  const pv = describeProvision(provisionBox);
  const wallet = t.inputBoxes.slice(3).map((b) => rehome(b, THROWAWAY.ergoTree));
  const resize = (newShares: bigint) =>
    buildResize({
      height: t.tx.outputs[0].creationHeight,
      inputs: wallet,
      owner: THROWAWAY,
      poolBox,
      vaultBox,
      provisionBox,
      newShares,
    });
  it.each([
    ["shrink to half", pv.shares / 2n],
    ["shrink by one share", pv.shares - 1n],
    ["shrink to one share", 1n],
    ["grow by one share", pv.shares + 1n],
    ["grow by a tenth", pv.shares + pv.shares / 10n],
  ] as const)("%s: every LithosDex input reduces to true; the owner signs and every proof verifies", (_n, size) => {
    const tx = resize(size);
    const r = reduce(lib29, tx, h);
    expect(r.err).toBeUndefined();
    expect(r.props!.slice(0, 3)).toEqual([TRUE, TRUE, TRUE]);
    const ok = sign(lib29, tx, h);
    expect(ok.err).toBeUndefined();
    expect(verifyAll(lib29, tx, ok.signed!, h).every(Boolean)).toBe(true);
    for (const i of v3(tx)) expect(parseTree(lib28, i.ergoTree).err).toMatch(/NonConsumedBytes/);
  });
  it("a shrink that takes one nanoERG more, or sets an entry one lower, makes the pool reduce to false", () => {
    const tx = resize(pv.shares / 2n);
    const more = structuredClone(tx);
    more.outputs[0].value = String(BigInt(tx.outputs[0].value) - 1n);
    const change = more.outputs.findIndex((o) => o.ergoTree === THROWAWAY.ergoTree);
    more.outputs[change].value = String(BigInt(tx.outputs[change].value) + 1n);
    expect(reduce(lib29, more, h).props!.slice(0, 3)).toEqual([FALSE, TRUE, TRUE]);
    const entry = structuredClone(tx);
    const e = describeProvision({ ...tx.outputs[1], boxId: "00".repeat(32), transactionId: "00".repeat(32), index: 0 });
    entry.outputs[1].additionalRegisters.R4 = SBigInt(e.entryX - 1n).toHex();
    expect(reduce(lib29, entry, h).props!.slice(0, 3)).toEqual([FALSE, TRUE, TRUE]);
  });
});

describe("refresh: permissionless once the box is old enough, refused by the logic before (synthetic boxes)", () => {
  // the recorded resize's provision box, re-dated; the payer is the throwaway key, which owns no NFT
  const t = poolOf("resize")[0];
  const h = poolHeaders(t);
  const H = t.inclusionHeight;
  const prov = t.inputBoxes[1];
  const payer = [syntheticFunding(THROWAWAY, t)];
  const refresh = (createdAt: number, height: number) =>
    buildRefresh({ height, inputs: payer, owner: THROWAWAY, provisionBox: rehomeAt(prov, prov.ergoTree, createdAt) });
  it("created REFRESH_AGE + 1 blocks before the spending block: reduces to true, signs and verifies", () => {
    const tx = refresh(H - REFRESH_AGE - 1, H);
    expect(tx.outputs[0].creationHeight).toBe(H);
    const r = reduce(lib29, tx, h);
    expect(r.props![0]).toBe(TRUE);
    const ok = sign(lib29, tx, h);
    expect(ok.err).toBeUndefined();
    expect(verifyAll(lib29, tx, ok.signed!, h).every(Boolean)).toBe(true);
    expect(parseTree(lib28, prov.ergoTree).err).toMatch(/NonConsumedBytes/);
  });
  it("exactly REFRESH_AGE blocks old, or a successor dated HEIGHT_SLACK back: the logic reduces to false", () => {
    // the builder checks against the height it is given; under the recorded block's HEIGHT the box is one block short
    expect(reduce(lib29, refresh(H - REFRESH_AGE, H + 1), h).props![0]).toBe(FALSE);
    expect(reduce(lib29, refresh(H - REFRESH_AGE - 5000, H - HEIGHT_SLACK), h).props![0]).toBe(FALSE);
    expect(reduce(lib29, refresh(H - REFRESH_AGE - 5000, H - HEIGHT_SLACK + 1), h).props![0]).toBe(TRUE);
    expect(() => refresh(H - REFRESH_AGE, H)).toThrow(/can be refreshed from height/);
  });
});

describe("negative control: ergo-lib-wasm 0.28.0 fails at parse on every direct pool transaction", () => {
  it("every one with headers", () => {
    let v3Inputs = 0;
    for (const t of withHeaders) {
      const tx = asRecorded(t);
      for (const i of v3(tx)) {
        v3Inputs++;
        expect(parseTree(lib28, i.ergoTree).err).toMatch(/NonConsumedBytes/);
      }
      expect(reduce(lib28, tx, poolHeaders(t)).err).toMatch(PARSE);
      expect(() => reduceTransaction(lib28 as unknown as ErgoLibModule, tx, pageHeaders(poolHeaders(t)))).toThrow(
        PARSE,
      );
    }
    expect(withHeaders.length).toBe(20);
    expect(v3Inputs).toBe(withHeaders.reduce((s, t) => s + fixedOf[t.kind], 0));
  });
});

// the counts this file stands on, printed for the record of the run
describe("summary", () => {
  it("prints the counts", () => {
    const pk = withHeaders.reduce<Record<string, number>>((m, t) => ({ ...m, [t.kind]: (m[t.kind] ?? 0) + 1 }), {});
    console.log(`lithos-lib: direct pool transactions with headers ${JSON.stringify(pk)}`);
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
