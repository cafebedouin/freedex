// The Lithos builders against the record: every order box placed on mainnet in the recorded set and every recorded
// fee claim, rebuilt from the recorded inputs and the terms the recorded boxes carry, then compared with what was
// mined. Plus the builders' own refusals. The library checks (reduce, sign, verify under the recorded headers) are in
// test/lithos-lib.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, FEE_CONTRACT } from "@fleet-sdk/core";
import { FEE } from "../machina/orders";
import { POOL_RECORD, RECORD, rebuildClaim, rebuildPlacement, rebuildPoolTx } from "../../../test/lithos-record";
import { SLong } from "@fleet-sdk/serializer";
import {
  LithosRefusal,
  PROVISION_GUARD_TREE,
  REFRESH_AGE,
  buildCancel,
  buildClaim,
  buildDeposit,
  buildDepositOrder,
  buildFlush,
  buildRedeem,
  buildRefresh,
  buildResize,
  buildSwap,
  buildSwapOrder,
  depositCost,
  refreshableAt,
  resizeQuote,
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

// ---- the direct pool operations against the recorded pool transactions ----

const SYNTH = ErgoAddress.fromPublicKey("02" + "33".repeat(32));
const treeSum = (outs: { ergoTree: string; value: Amount }[], tree: string) =>
  outs.filter((x) => x.ergoTree === tree).reduce((s, x) => s + BigInt(x.value), 0n);
const tokenSum = (outs: { ergoTree: string; assets: { tokenId: string; amount: Amount }[] }[], tree: string) => {
  const m = new Map<string, bigint>();
  for (const o of outs)
    if (o.ergoTree === tree) for (const a of o.assets) m.set(a.tokenId, (m.get(a.tokenId) ?? 0n) + BigInt(a.amount));
  return [...m.entries()].filter(([, v]) => v !== 0n).sort();
};
const fixedInputs = { swap: 1, deposit: 1, redeem: 2, flush: 2, resize: 3 } as const;
const POOL_COUNTS: Record<string, number> = {};
const DEPOSIT_EXTRA: [string, bigint, bigint][] = [];

describe("direct pool operations: the builders' pool, provision and vault successors are the recorded ones", () => {
  afterAll(() => {
    console.log(
      `executed deposits: nanoERG and LIT units the executor put in beyond depositCost ${JSON.stringify(DEPOSIT_EXTRA, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`,
    );
    // facts about the record, checked so a changed fixture is noticed
    expect(POOL_COUNTS).toEqual({
      "swap direct": 1,
      "swap order": 45,
      "deposit direct": 1,
      "deposit order": 5,
      "redeem direct": 1,
      "redeem order": 1,
      "flush direct": 8,
      "resize direct": 1,
    });
  });
  it.each(POOL_RECORD.txs.map((t) => [t.kind, t.txId.slice(0, 8), t] as const))("%s %s", (_k, _id, t) => {
    const key = `${t.kind} ${t.direct ? "direct" : "order"}`;
    POOL_COUNTS[key] = (POOL_COUNTS[key] ?? 0) + 1;
    const flushNoWallet = t.kind === "flush" && t.inputBoxes.length === 2;
    const tx = rebuildPoolTx(t, t.direct && !flushNoWallet ? undefined : SYNTH);
    const n = fixedInputs[t.kind];
    // the contracts' fixed inputs, in place, with the recorded context variables
    for (let i = 0; i < n; i++) {
      expect(tx.inputs[i].boxId).toBe(t.tx.inputs[i].boxId);
      expect(tx.inputs[i].extension).toEqual(t.tx.inputs[i].extension);
    }
    // their successors byte for byte (a deposit's provision box too: output 1)
    const successors = t.kind === "swap" ? 1 : t.kind === "redeem" ? 1 : t.kind === "deposit" ? 2 : n;
    if (t.kind === "deposit" && !t.direct) {
      // Intended difference: an executor sizes a deposit from the order's two offers and refunds the excess as the
      // order contract computes it (LithosDexExecution.depositSplit), so the pool may take a few units more of a
      // side than the cheapest deposit for the same shares, which is what this builder pays (depositCost). Same
      // shares, same provision box; the recorded pool took at least as much of each side.
      same(tx.outputs[1], t.tx.outputs[1]);
      expect(tx.outputs[0].additionalRegisters).toEqual(t.tx.outputs[0].additionalRegisters);
      const dx = BigInt(t.tx.outputs[0].value) - BigInt(tx.outputs[0].value);
      const dy = BigInt(t.tx.outputs[0].assets[1].amount) - BigInt(tx.outputs[0].assets[1].amount);
      DEPOSIT_EXTRA.push([t.txId.slice(0, 8), dx, dy]);
      expect(dx >= 0n && dy >= 0n).toBe(true);
    } else for (let i = 0; i < successors; i++) same(tx.outputs[i], t.tx.outputs[i]);
    if (!t.direct || flushNoWallet) return;
    // A wallet made it: everything else that reached the wallet matches too. Intended differences: the page's
    // 0.001 ERG miner fee (the client paid 0.002), so the wallet keeps 0.001 ERG more; Fleet may spend fewer of the
    // wallet's boxes than the recorded transaction did (it spent extra boxes for the client's larger fee, or to
    // consolidate), so the comparison is of what the wallet gained or lost, per token and in ERG.
    const owner = t.inputBoxes[n].ergoTree;
    const recFee = treeSum(t.tx.outputs, FEE_CONTRACT);
    expect(treeSum(tx.outputs, FEE_CONTRACT)).toBe(FEE);
    const spent = (ids: string[]) => t.inputBoxes.filter((b) => ids.includes(b.boxId) && b.ergoTree === owner);
    const recSpent = spent(t.tx.inputs.map((i) => i.boxId));
    const mySpent = spent(tx.inputs.map((i) => i.boxId));
    const recNet = treeSum(t.tx.outputs, owner) - treeSum(recSpent, owner);
    const net = treeSum(tx.outputs, owner) - treeSum(mySpent, owner);
    expect(net - recNet).toBe(recFee - FEE);
    type Held = { ergoTree: string; assets: { tokenId: string; amount: Amount }[] }[];
    const tokenNet = (outs: Held, ins: Held) => {
      const m = new Map(tokenSum(outs, owner));
      for (const [id, v] of tokenSum(ins, owner)) m.set(id, (m.get(id) ?? 0n) - v);
      return [...m.entries()].filter(([, v]) => v !== 0n).sort();
    };
    expect(tokenNet(tx.outputs, mySpent)).toEqual(tokenNet(t.tx.outputs, recSpent));
    if (t.kind === "deposit") same(tx.outputs[2], t.tx.outputs[2]); // the ownership NFT, its EIP-4 registers included
    // the signer: a deposit's provision box is the one script to allow; nothing but the wallet's key signs
    const h = signerHints(tx, ErgoAddress.fromErgoTree(owner));
    expect(h.allowTrees).toEqual(t.kind === "deposit" ? [PROVISION_GUARD_TREE] : []);
    expect(h.signTrees).toEqual([]);
    expect(h.v3Inputs).toEqual([...Array(n).keys()]);
  });
});

describe("the direct builders refuse, each with its code", () => {
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof LithosRefusal ? e.code : `not a refusal: ${String(e)}`;
    }
    return "built";
  };
  const resize = POOL_RECORD.txs.find((t) => t.kind === "resize")!;
  const [poolBox, provisionBox, vaultBox] = resize.inputBoxes;
  const wallet = resize.inputBoxes.slice(3);
  const owner = ErgoAddress.fromErgoTree(wallet[0].ergoTree);
  const pv = describeProvision(provisionBox);
  const base = { height: resize.inclusionHeight, inputs: wallet, owner, poolBox };
  const noNft = wallet.map((b) => ({ ...b, assets: b.assets.filter((a) => a.tokenId !== pv.ownerNft) }));
  it("swap: a non-positive amount, a minimum the pool does not pay", () => {
    expect(code(() => buildSwap({ ...base, direction: "erg-to-lit", amountIn: 0n, minOut: 1n }))).toBe("amount");
    const q = quoteSwap(describePool(poolBox), true, 1_000_000n);
    expect(code(() => buildSwap({ ...base, direction: "erg-to-lit", amountIn: 1_000_000n, minOut: q + 1n }))).toBe(
      "pool-moved",
    );
    expect(code(() => buildSwap({ ...base, direction: "erg-to-lit", amountIn: 1_000_000n, minOut: q }))).toBe("built");
  });
  it("deposit: no shares; redeem: no NFT, or a supply left under MIN_SUPPLY", () => {
    expect(code(() => buildDeposit({ ...base, shares: 0n }))).toBe("amount");
    expect(code(() => buildDeposit({ ...base, shares: 1n }))).toBe("built");
    expect(code(() => buildRedeem({ ...base, inputs: noNft, provisionBox }))).toBe("no-owner-nft");
    const supply = describePool(poolBox).supply;
    const huge = {
      ...provisionBox,
      additionalRegisters: { ...provisionBox.additionalRegisters, R7: SLong(supply).toHex() },
    };
    expect(code(() => buildRedeem({ ...base, provisionBox: huge }))).toBe("min-supply");
    expect(code(() => buildRedeem({ ...base, provisionBox }))).toBe("built");
  });
  it("flush: nothing pending (the pool a flush left)", () => {
    const flush = POOL_RECORD.txs.find((t) => t.kind === "flush")!;
    expect(code(() => buildFlush({ ...base, poolBox: flush.tx.outputs[0], vaultBox: flush.tx.outputs[1] }))).toBe(
      "nothing-pending",
    );
    expect(code(() => buildFlush({ ...base, poolBox: flush.inputBoxes[0], vaultBox: flush.inputBoxes[1] }))).toBe(
      "built",
    );
  });
  it("resize: to the same size, to nothing, without the NFT, under MIN_SUPPLY", () => {
    const r = { ...base, vaultBox, provisionBox };
    expect(code(() => buildResize({ ...r, newShares: pv.shares }))).toBe("same-size");
    expect(code(() => buildResize({ ...r, newShares: 0n }))).toBe("zero-size");
    expect(code(() => buildResize({ ...r, newShares: -1n }))).toBe("zero-size");
    expect(code(() => buildResize({ ...r, inputs: noNft, newShares: pv.shares + 1n }))).toBe("no-owner-nft");
    // a provision holding the whole supply, shrunk to one share
    const supply = describePool(poolBox).supply;
    const whole = {
      ...provisionBox,
      additionalRegisters: { ...provisionBox.additionalRegisters, R7: SLong(supply).toHex() },
    };
    expect(code(() => buildResize({ ...r, provisionBox: whole, newShares: 1n }))).toBe("min-supply");
    expect(code(() => buildResize({ ...r, newShares: 1n }))).toBe("built");
  });
  it("refresh: a box younger than REFRESH_AGE, at any height before refreshableAt", () => {
    const at = refreshableAt(provisionBox.creationHeight);
    expect(at).toBe(provisionBox.creationHeight + REFRESH_AGE + 1);
    expect(code(() => buildRefresh({ ...base, height: at - 1, provisionBox }))).toBe("not-old-enough");
    expect(code(() => buildRefresh({ ...base, height: at, provisionBox }))).toBe("built");
  });
  it("the resize's arithmetic: the entry keeps what the provision had earned, rounded down", () => {
    const p = describePool(poolBox);
    for (const size of [pv.shares / 2n, pv.shares + 1n, pv.shares * 2n]) {
      const q = resizeQuote(p, pv, size);
      const before = pv.shares * (p.accX - pv.entryX);
      const after = size * (p.accX - q.entryX);
      expect(after <= before).toBe(true);
      expect(before - after < size).toBe(true);
      // the cheapest grow buys at least the shares added, by the pool's own bound; a shrink takes at most its share
      if (q.delta > 0n) expect((q.x * p.supply) / p.reservesX >= q.delta).toBe(true);
      else expect(q.x * p.supply <= -q.delta * p.reservesX).toBe(true);
    }
    expect(depositCost(p, 1n)).toEqual({ x: 1n, y: (p.reservesY + p.supply - 1n) / p.supply });
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
