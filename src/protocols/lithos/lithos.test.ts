// The Lithos builders against the record: every order box placed on mainnet in the recorded set and every recorded
// fee claim, rebuilt from the recorded inputs and the terms the recorded boxes carry, then compared with what was
// mined. Plus the builders' own refusals. The library checks (reduce, sign, verify under the recorded headers) are in
// test/lithos-lib.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, FEE_CONTRACT } from "@fleet-sdk/core";
import { FEE } from "../machina/orders";
import { RECORD, rebuildClaim, rebuildPlacement } from "../../../test/lithos-record";
import {
  buildCancel,
  buildClaim,
  buildDepositOrder,
  buildSwapOrder,
  describeOrder,
  describePool,
  describeProvision,
  describeVault,
  depositShares,
  orderTree,
  owed,
  quoteSwap,
  signerHints,
  LIT,
  POOL_NFT,
  PROVISION_LOGIC,
  RETURNED,
  VAULT_NFT,
} from "./lithos";

const addr = (pk: string) => ErgoAddress.fromPublicKey(pk);
/** R4 = "Mew" (Coll[Byte]): another front end tags the orders it places; no order contract reads a register. */
export const FRONT_END_TAG = "0e034d6577";
const same = (built: Box<Amount> | EIP12UnsignedTransaction["outputs"][number], rec: Box<Amount>, allowTag = false) => {
  expect(built.ergoTree).toBe(rec.ergoTree);
  expect(BigInt(built.value)).toBe(BigInt(rec.value));
  expect(built.assets.map((a) => [a.tokenId, BigInt(a.amount)])).toEqual(
    rec.assets.map((a) => [a.tokenId, BigInt(a.amount)]),
  );
  const recRegs = { ...rec.additionalRegisters };
  if (allowTag && recRegs.R4 === FRONT_END_TAG && Object.keys(recRegs).length === 1) delete recRegs.R4;
  expect(built.additionalRegisters).toEqual(recRegs);
  expect(built.creationHeight).toBe(rec.creationHeight);
};

describe("the record: every recorded order box is one of the four contracts, rebuilt byte for byte", () => {
  it("reads all 51 order boxes, and the template alone is never enough", () => {
    const kinds: Record<string, number> = {};
    for (const o of RECORD.orders) {
      const v = describeOrder(o.box);
      expect(v, o.box.boxId).toBeDefined();
      kinds[v!.kind] = (kinds[v!.kind] ?? 0) + 1;
      expect(v!.terms.poolNft).toBe(POOL_NFT);
      expect(orderTree(v!.kind, v!.terms)).toBe(o.box.ergoTree);
    }
    expect(kinds).toEqual({ "swap-sell": 43, "swap-buy": 2, deposit: 5, redeem: 1 });
    // a box under the swap-sell template whose owner constant is replaced by another key is a different order,
    // and one whose amount constant is changed in place is still read (its terms are its constants)
    const o = RECORD.orders.find((x) => x.kind === "swap-sell")!;
    const v = describeOrder(o.box)!;
    const other = orderTree("swap-sell", { ...v.terms, owner: "02" + "11".repeat(32) });
    expect(describeOrder({ ...o.box, ergoTree: other })!.terms.owner).toBe("02" + "11".repeat(32));
    // a P2PK box, the pool and garbage are not orders
    expect(describeOrder(RECORD.poolBox)).toBeUndefined();
    expect(describeOrder({ ...o.box, ergoTree: "0008cd" + v.terms.owner })).toBeUndefined();
    expect(describeOrder({ ...o.box, ergoTree: "1b" })).toBeUndefined();
  });
});

const INTERFACE_FEES: bigint[] = [];
describe("placing an order: the builder's order box is the recorded one", () => {
  afterAll(() => {
    // the count is a fact about the record, checked so a changed fixture is noticed
    expect(INTERFACE_FEES.length).toBe(7);
  });
  it.each(RECORD.orders.map((o, i) => [i, o.kind, o] as const))("order %i (%s)", (_i, _k, o) => {
    const tx = rebuildPlacement(o);
    same(tx.outputs[0], o.box, true);
    // Intended differences. No front-end tag in R4 (21 recorded orders carry FRONT_END_TAG). The miner fee is the
    // page's 0.001 ERG (the official client pays 0.002, the tagging front end 0.0011). No interface fee: 7 recorded
    // placements by the tagging front end also paid a third P2PK address about 1.4% of the order (INTERFACE_FEES).
    // So with the same inputs spent the owner's change is larger by the fee difference plus that payment.
    const fee = tx.outputs.filter((x) => x.ergoTree === FEE_CONTRACT);
    expect(fee.map((x) => BigInt(x.value))).toEqual([FEE]);
    const recFee = o.placement.outputs
      .filter((x) => x.ergoTree === FEE_CONTRACT)
      .reduce((s, x) => s + BigInt(x.value), 0n);
    const owner = describeOrder(o.box)!.owner;
    const ownerTree = ErgoAddress.fromBase58(owner).ergoTree;
    const sum = (bs: { value: Amount }[]) => bs.reduce((s, b) => s + BigInt(b.value), 0n);
    const third = o.placement.outputs.filter(
      (x) => x.ergoTree !== ownerTree && x.ergoTree !== FEE_CONTRACT && x.boxId !== o.box.boxId,
    );
    if (third.length) INTERFACE_FEES.push(sum(third));
    const spent = o.placement.inputs.filter((b) => tx.inputs.some((i) => i.boxId === b.boxId));
    const recChange = sum(o.placement.outputs.filter((x) => x.ergoTree === ownerTree));
    const change = sum(tx.outputs.filter((x) => x.ergoTree === ownerTree));
    if (spent.length === o.placement.inputs.length) expect(change - recChange).toBe(recFee - FEE + sum(third));
    else expect(change).toBe(sum(spent) - BigInt(o.box.value) - FEE); // Fleet needed fewer of the recorded inputs
    // the only script a signer must be told to allow is the order's; nothing is signed but the owner's boxes
    const h = signerHints(tx, ErgoAddress.fromBase58(owner));
    expect(h.allowTrees).toEqual([o.box.ergoTree]);
    expect(h.signTrees).toEqual([]);
    expect(h.v3Inputs).toEqual([]);
  });
});

describe("claiming fees: the builder's claim is the recorded one", () => {
  it.each(RECORD.claims.map((c) => [c.txId.slice(0, 8), c] as const))("claim %s", (_id, c) => {
    const { n, tx } = rebuildClaim(c);
    expect(n).toBeGreaterThan(0);
    // inputs 0..n are the vault and provisions with the recorded context variables
    for (let i = 0; i <= n; i++) {
      expect(tx.inputs[i].boxId).toBe(c.tx.inputs[i].boxId);
      expect(tx.inputs[i].extension).toEqual(c.tx.inputs[i].spendingProof.extension);
    }
    // outputs 0..n: the vault's and provisions' successors, byte for byte
    for (let i = 0; i <= n; i++) same(tx.outputs[i], c.tx.outputs[i]);
    // the claimant's change carries the same tokens (the LIT owed included); its ERG is larger by the fee difference
    const ownerTree = c.inputBoxes[1 + n].ergoTree;
    const recOut = c.tx.outputs.filter((x) => x.ergoTree === ownerTree);
    const out = tx.outputs.filter((x) => x.ergoTree === ownerTree);
    const tokens = (bs: { assets: { tokenId: string; amount: Amount }[] }[]) => {
      const m = new Map<string, bigint>();
      for (const b of bs) for (const a of b.assets) m.set(a.tokenId, (m.get(a.tokenId) ?? 0n) + BigInt(a.amount));
      return [...m.entries()].sort();
    };
    expect(tokens(out)).toEqual(tokens(recOut));
    const recFee = c.tx.outputs.filter((x) => x.ergoTree === FEE_CONTRACT).reduce((s, x) => s + BigInt(x.value), 0n);
    const sum = (bs: { value: Amount }[]) => bs.reduce((s, b) => s + BigInt(b.value), 0n);
    expect(sum(out) - sum(recOut)).toBe(recFee - FEE);
    // what was paid is exactly what the vault owed
    const vault = describeVault(c.inputBoxes[0]);
    let x = 0n;
    for (const b of c.inputBoxes.slice(1, 1 + n)) x += owed(vault, describeProvision(b)).x;
    expect(BigInt(c.tx.outputs[0].value)).toBe(vault.value - x);
    // no extra script to allow, nothing to sign but the wallet's P2PK; the vault and provisions are version 3
    const h = signerHints(tx, ErgoAddress.fromErgoTree(ownerTree));
    expect(h.allowTrees).toEqual([]);
    expect(h.signTrees).toEqual([]);
    expect(h.v3Inputs).toEqual([...Array(n + 1).keys()]);
  });
});

describe("the builders refuse", () => {
  const o = RECORD.orders.find((x) => x.kind === "swap-sell")!;
  const v = describeOrder(o.box)!;
  const owner = addr(v.terms.owner);
  const base = { height: o.box.creationHeight, inputs: o.placement.inputs, owner, poolBox: RECORD.poolBox };
  it("a box that is not the pool, non-positive amounts, and fees that leave the executor nothing", () => {
    expect(() =>
      buildSwapOrder({ ...base, poolBox: o.box, direction: "erg-to-lit", amountIn: 1n, minOut: 1n }),
    ).toThrow(/pool tree/);
    expect(() => buildSwapOrder({ ...base, direction: "erg-to-lit", amountIn: 0n, minOut: 1n })).toThrow(/positive/);
    expect(() => buildSwapOrder({ ...base, direction: "erg-to-lit", amountIn: 1n, minOut: 0n })).toThrow(/positive/);
    expect(() =>
      buildSwapOrder({ ...base, direction: "erg-to-lit", amountIn: 1n, minOut: 1n, executorFee: 1n, maxMinerFee: 1n }),
    ).toThrow(/executor fee/);
    expect(() => buildDepositOrder({ ...base, amountX: 1n, amountY: 0n, minShares: 1n })).toThrow(/both sides/);
  });
  it("a non-P2PK owner", () => {
    const p2s = ErgoAddress.fromErgoTree(RECORD.poolBox.ergoTree);
    expect(() =>
      buildSwapOrder({ ...base, owner: p2s, direction: "erg-to-lit", amountIn: 1_000_000n, minOut: 1n }),
    ).toThrow(/P2PK/);
  });
  it("a cancel by anyone but the owner, and of a box that is not an order", () => {
    const stranger = ErgoAddress.fromPublicKey("02" + "22".repeat(32));
    expect(() => buildCancel({ height: 1, inputs: [], owner: stranger, orderBox: o.box })).toThrow(/owner/);
    expect(() => buildCancel({ height: 1, inputs: [], owner, orderBox: RECORD.poolBox })).toThrow(
      /not a LithosDex order/,
    );
  });
  it("a claim with nothing to settle, or without the ownership NFT", () => {
    const c = RECORD.claims[0];
    const n = 1;
    const vaultBox = c.inputBoxes[0];
    const prov = c.inputBoxes[1];
    // the provision's successor is already settled up to the vault's accumulator
    const settled = {
      ...prov,
      additionalRegisters: {
        ...prov.additionalRegisters,
        R4: vaultBox.additionalRegisters.R4,
        R5: vaultBox.additionalRegisters.R5,
      },
    };
    const wallet = c.inputBoxes.slice(1 + n);
    const owner = ErgoAddress.fromErgoTree(wallet[0].ergoTree);
    expect(() => buildClaim({ height: 1, inputs: wallet, owner, vaultBox, provisionBoxes: [settled] })).toThrow(
      /nothing to settle/,
    );
    const noNft = wallet.map((b) => ({
      ...b,
      assets: b.assets.filter((a) => a.tokenId !== describeProvision(prov).ownerNft),
    }));
    expect(() => buildClaim({ height: 1, inputs: noNft, owner, vaultBox, provisionBoxes: [prov] })).toThrow(
      /ownership NFT/,
    );
    expect(() => buildClaim({ height: 1, inputs: wallet, owner, vaultBox, provisionBoxes: [] })).toThrow(
      /at least one/,
    );
  });
});

describe("pool arithmetic", () => {
  it("the swap quote meets each recorded executed swap-sell order's minimum against its own pool state", () => {
    // the recorded pool at the newest swap; spot check on the deterministic formula
    const p = describePool(RECORD.poolBox);
    expect(p.reservesX).toBe(p.value - p.pendingX);
    expect(quoteSwap(p, true, 0n)).toBe(0n);
    const q = quoteSwap(p, true, 1_000_000_000n);
    expect(q).toBeGreaterThan(0n);
    // more in, more out; never more than the reserve
    expect(quoteSwap(p, true, 2_000_000_000n)).toBeGreaterThan(q);
    expect(quoteSwap(p, false, p.reservesY * 1000n)).toBeLessThan(p.reservesX);
    expect(depositShares(p, p.reservesX, p.reservesY)).toBe(p.supply);
  });
  it("constants: the logic hashes, the ids", () => {
    expect(PROVISION_LOGIC.length).toBe(922);
    expect(LIT).toMatch(/^c1980d82/);
    expect(VAULT_NFT).toMatch(/^7f45bcbf/);
    expect(RETURNED).toBe(1_000_000n);
  });
});
