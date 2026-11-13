// Writes one unsigned mainnet transaction for an address, built by the page's own builders from that address's
// confirmed boxes and live chain state, in the node JSON shape a separate signer takes (inputs as {boxId,
// spendingProof: {proofBytes: "", extension}}). Nothing here signs or submits, and nothing reads a key.
//
//   node scripts/mainnet-run.ts <address> <step> [--out <dir>]      (default dir: ./mainnet-unsigned)
//   node scripts/mainnet-run.ts <address> status                    what the address has open, and the candidates
//
// Steps (each reads the chain for what the previous one left, so rerun after each is mined):
//   L1  LithosDex swap order, 0.001 ERG for LIT, its minimum twice the pool's quote: held open, so L2 can cancel it
//   L2  cancel the L1 order (the address's open ERG-to-LIT order whose minimum the pool cannot meet)
//   L3  LithosDex swap order, 0.001 ERG for LIT at the pool's quote less 1%: for the executor to fill
//   L3c cancel an L3 order the executor has not filled (any open ERG-to-LIT order of the address)
//   L4  LithosDex swap order selling all the address's LIT for ERG, its minimum twice the quote: held open
//   L5  cancel the L4 order
//   M1  Machina version-2 limit order selling 10 FAKU units at 0.001 ERG per unit (thirty times the pool)
//   M2  close the M1 order as its owner
//   M3  the same order again
//   M4  fill the M3 order from the same address (buy its 10 units back)
//   M5  fill a stranger's version-2 order: --box <id> --units <n> (status lists the candidates)
// Set EXCLUDE=<boxId>[,<boxId>] to keep boxes a pending transaction spends out of the selection.
//
// For each step it prints the builder call, what is locked, the miner fee, what comes back, the scripts a guarded
// signer must allow as outputs (--allow-tree) and sign with the address's key (--sign-tree), and the reduction of
// every input by ergo-lib-wasm (the page's binding) against the explorer's last ten headers.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, ErgoTree, FEE_CONTRACT } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import { E2T_LIMIT_V2_TEMPLATE_SHA256, Explorer } from "../src/explorer.ts";
import { HEADERS_NEEDED, QR_MAX_CHARS, reduceTransaction, toEip12Box, type ErgoLibModule } from "../src/ergopay.ts";
import {
  DEFAULT_EXECUTOR_FEE,
  LIT,
  ORDER_KINDS,
  POOL_NFT,
  PROVISION_GUARD_TREE,
  buildCancel,
  buildSwapOrder,
  describeOrder,
  describePool,
  describeProvision,
  orderTemplateSha256,
  quoteSwap,
  signerHints,
  type OrderView,
} from "../src/protocols/lithos/lithos.ts";
import {
  E2T_V2,
  buildClose,
  buildCreate,
  buildFill,
  capacity,
  describe as describeMachina,
} from "../src/protocols/machina/orders.ts";

const require = createRequire(import.meta.url);
const lib = require("ergo-lib-wasm-nodejs") as ErgoLibModule;

const FAKU = "f0cac602d618081f46db086726d3c4da53006b646b50e382989054dcf3c93bd8";
const M_UNITS = 10n;
const M_PRICE = 1_000_000n; // nanoERG per FAKU unit
const L_AMOUNT = 1_000_000n; // 0.001 ERG
const MAX_STRANGER_FILL = 50_000_000n; // 0.05 ERG

const argv = process.argv.slice(2);
const [address, step] = argv;
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!address || !step) throw new Error("usage: node scripts/mainnet-run.ts <address> <step|status> [--out <dir>]");
const owner = ErgoAddress.fromBase58(address);
const ownerPk = hex.encode(owner.getPublicKeys()[0]);
const explorer = new Explorer(process.env.VITE_EXPLORER);
const height = await explorer.height();
const exclude = new Set((process.env.EXCLUDE ?? "").split(",").filter(Boolean));
const boxes = (await explorer.unspentByAddress(address, 100)).filter((b) => !exclude.has(b.boxId));
const inputs = boxes.map(toEip12Box);
const erg = (x: bigint) => `${(Number(x) / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "")} ERG`;

async function poolNow() {
  const box = await explorer.latestByToken(POOL_NFT);
  return { box, v: describePool(box) };
}
async function myLithosOrders(): Promise<{ box: Box<bigint>; v: OrderView }[]> {
  const out: { box: Box<bigint>; v: OrderView }[] = [];
  for (const kind of ORDER_KINDS)
    for (const box of await explorer.byTemplate(orderTemplateSha256(kind)))
      if (describeOrder(box)?.terms.owner === ownerPk) out.push({ box, v: describeOrder(box)! });
  return out;
}
async function v2Orders() {
  return (await explorer.byTemplate(E2T_LIMIT_V2_TEMPLATE_SHA256, 200)).flatMap((box) => {
    try {
      return [{ box, v: describeMachina(box) }];
    } catch {
      return [];
    }
  });
}
const held = (id: string) =>
  boxes.reduce((s, b) => s + b.assets.filter((a) => a.tokenId === id).reduce((t, a) => t + a.amount, 0n), 0n);

if (step === "status") {
  const { v: p } = await poolNow();
  console.log(
    `height ${height}; ${address}: ${boxes.length} boxes, ${erg(boxes.reduce((s, b) => s + b.value, 0n))}, ${held(LIT)} LIT units, ${held(FAKU)} FAKU units`,
  );
  console.log(
    `LithosDex pool ${p.boxId.slice(0, 12)}…: ${erg(p.reservesX)} / ${p.reservesY} LIT units; 0.001 ERG buys ${quoteSwap(p, true, L_AMOUNT)} units now`,
  );
  console.log("open LithosDex orders, every owner (fillable = the pool meets the minimum now):");
  for (const kind of ORDER_KINDS)
    for (const box of await explorer.byTemplate(orderTemplateSha256(kind))) {
      const v = describeOrder(box);
      if (!v) continue;
      const t = v.terms;
      const fill =
        kind === "swap-sell"
          ? quoteSwap(p, true, t.baseAmount!) >= t.minQuote!
          : kind === "swap-buy"
            ? quoteSwap(p, false, v.token!.amount) - t.executorFee >= t.minQuote!
            : undefined;
      console.log(
        `  ${kind} ${box.boxId.slice(0, 12)}… placed at ${box.creationHeight}, ${erg(v.value)}${v.token ? ` + ${v.token.amount} units` : ""}, executor fee ${erg(t.executorFee)}${fill === undefined ? "" : fill ? ", FILLABLE now" : ", not fillable now"}${t.owner === ownerPk ? " (this address)" : ""}`,
      );
    }
  const provs = (
    await explorer.byTemplate(hex.encode(sha256(new ErgoTree(PROVISION_GUARD_TREE).template)), 500)
  ).filter((b) => b.ergoTree === PROVISION_GUARD_TREE);
  const tokens = new Set(boxes.flatMap((b) => b.assets.map((a) => a.tokenId)));
  const mine = provs.filter((b) => tokens.has(describeProvision(b).ownerNft));
  console.log(
    `provisions: ${provs.length} live under the pinned guard; ${mine.length} owned by this address (a claim needs one)`,
  );
  console.log(`Machina version-2 orders a taker can fill for at most ${erg(MAX_STRANGER_FILL)} (M5 candidates):`);
  for (const { box, v } of await v2Orders()) {
    const cost = v.takerAction === "buy" ? v.tokenAmount * v.price : 0n;
    if (v.takerAction === "buy" && cost > 0n && cost <= MAX_STRANGER_FILL)
      console.log(
        `  ${box.boxId} ${v.tokenAmount} units of ${v.tokenId.slice(0, 12)}… at ${v.price} nanoERG/unit: ${erg(cost)} for all, owner ${v.owner.slice(0, 10)}…${v.owner === address ? " (this address)" : ""}`,
      );
    if (v.takerAction === "sell" && v.value <= MAX_STRANGER_FILL)
      console.log(
        `  ${box.boxId} buys ${v.tokenId.slice(0, 12)}… at ${v.price} nanoERG/unit with ${erg(v.value)} (a taker sells tokens into it; capacity ${capacity(v)} units)`,
      );
  }
  process.exit(0);
}

let tx: EIP12UnsignedTransaction;
let call: string;
let note: string;
const lithosHeld = async (dir: "swap-sell" | "swap-buy") => {
  const { v: p } = await poolNow();
  return (await myLithosOrders()).filter(({ v }) => {
    if (v.kind !== dir) return false;
    const q =
      dir === "swap-sell"
        ? quoteSwap(p, true, v.terms.baseAmount!)
        : quoteSwap(p, false, v.token!.amount) - v.terms.executorFee;
    return q < v.terms.minQuote!;
  });
};

if (step === "L1" || step === "L3") {
  const { box: poolBox, v: p } = await poolNow();
  const q = quoteSwap(p, true, L_AMOUNT);
  const minOut = step === "L1" ? 2n * q : q - q / 100n;
  call = `buildSwapOrder({ direction: "erg-to-lit", amountIn: ${L_AMOUNT}n, minOut: ${minOut}n, executorFee: ${DEFAULT_EXECUTOR_FEE}n, maxMinerFee: 1000000n })`;
  note =
    step === "L1"
      ? `held open: the pool pays ${q} units now, the order asks ${minOut}`
      : `for the executor: the pool pays ${q} units now, the order asks ${minOut}; if filled, ${erg(1_000_000n)} and the LIT come back in the reward box`;
  tx = buildSwapOrder({ height, inputs, owner, poolBox, direction: "erg-to-lit", amountIn: L_AMOUNT, minOut });
} else if (step === "L4") {
  const { box: poolBox, v: p } = await poolNow();
  const amountIn = held(LIT);
  if (amountIn === 0n) throw new Error("the address holds no LIT: L3 has not been filled");
  const q = quoteSwap(p, false, amountIn) - DEFAULT_EXECUTOR_FEE;
  const minOut = q > 0n ? 2n * q : 1_000_000n;
  call = `buildSwapOrder({ direction: "lit-to-erg", amountIn: ${amountIn}n, minOut: ${minOut}n })`;
  note = `held open: the pool pays ${q} nanoERG net now, the order asks ${minOut}`;
  tx = buildSwapOrder({ height, inputs, owner, poolBox, direction: "lit-to-erg", amountIn, minOut });
} else if (step === "L2" || step === "L5" || step === "L3c") {
  const candidates =
    step === "L2"
      ? await lithosHeld("swap-sell")
      : step === "L5"
        ? await lithosHeld("swap-buy")
        : (await myLithosOrders()).filter(({ v }) => v.kind === "swap-sell");
  const pick = opt("box") ? candidates.find((c) => c.box.boxId === opt("box")) : candidates[0];
  if (!pick) throw new Error(`no open order of this address for ${step}`);
  call = `buildCancel({ orderBox: ${pick.box.boxId} })`;
  note = `${pick.v.kind} order placed at ${pick.box.creationHeight}: ${erg(pick.v.value)}${pick.v.token ? ` and ${pick.v.token.amount} LIT units` : ""} back`;
  tx = buildCancel({ height, inputs, owner, orderBox: pick.box });
} else if (step === "M1" || step === "M3") {
  if (held(FAKU) < M_UNITS) throw new Error("the address holds fewer than 10 FAKU units");
  call = `buildCreate({ side: "sell-tokens", quoteTokenId: FAKU, tokenAmount: ${M_UNITS}n, price: ${M_PRICE}n, treeVersion: 2 })`;
  note = `${M_UNITS} FAKU units offered at ${M_PRICE} nanoERG each; the box holds the SDK's minimum value`;
  tx = buildCreate({
    height,
    inputs,
    owner,
    side: "sell-tokens",
    quoteTokenId: FAKU,
    tokenAmount: M_UNITS,
    price: M_PRICE,
    treeVersion: 2,
  });
} else if (step === "M2" || step === "M4") {
  const mine = (await v2Orders()).filter(
    ({ v }) => v.owner === address && v.tokenId === FAKU && v.tokenAmount === M_UNITS,
  );
  const pick = opt("box") ? mine.find((m) => m.box.boxId === opt("box")) : mine[0];
  if (!pick) throw new Error(`no open version-2 FAKU order of this address for ${step}`);
  if (step === "M2") {
    call = `buildClose({ orderBox: ${pick.box.boxId} })`;
    note = `the order's ${erg(pick.v.value)} and ${M_UNITS} FAKU units back`;
    tx = buildClose({ height, inputs, owner, orderBox: pick.box });
  } else {
    call = `buildFill({ orderBox: ${pick.box.boxId}, tokenAmount: ${M_UNITS}n })`;
    note = `the address pays ${erg(M_UNITS * M_PRICE)} into its own order and takes the ${M_UNITS} units; the full fill sends the box's value and the payment to the owner, this address`;
    tx = buildFill({ height, inputs, taker: owner, orderBox: pick.box, tokenAmount: M_UNITS });
  }
} else if (step === "M5") {
  const id = opt("box");
  const units = opt("units");
  if (!id || !units) throw new Error("M5 needs --box <orderBoxId> --units <n> (see status)");
  const pick = (await v2Orders()).find((o) => o.box.boxId === id);
  if (!pick) throw new Error(`${id} is not an open version-2 Machina order`);
  const cost = pick.v.takerAction === "buy" ? BigInt(units) * pick.v.price : 0n;
  if (cost > MAX_STRANGER_FILL) throw new Error(`that fill costs ${erg(cost)}, above ${erg(MAX_STRANGER_FILL)}`);
  call = `buildFill({ orderBox: ${id}, tokenAmount: ${units}n })`;
  note = `taker ${pick.v.takerAction}s ${units} units at ${pick.v.price} nanoERG/unit (${erg(cost)}) from ${pick.v.owner}`;
  tx = buildFill({ height, inputs, taker: owner, orderBox: pick.box, tokenAmount: BigInt(units) });
} else {
  throw new Error(`unknown step ${step}`);
}

// ---- what the signer needs, what it costs, what the library makes of it ----
const lithosHints = signerHints(tx, owner);
// a Machina order spent by its owner reduces to the owner's key too
const machinaSign = tx.inputs.filter((i) => {
  try {
    return E2T_V2.validate(i.ergoTree) || describeMachina(i as Box<Amount>).owner === address;
  } catch {
    return false;
  }
});
const signTrees = [
  ...new Set([...lithosHints.signTrees, ...(step === "M2" ? machinaSign.map((i) => i.ergoTree) : [])]),
];
const allowTrees = lithosHints.allowTrees;
const walletIn = tx.inputs
  .filter((i) => i.ergoTree === owner.ergoTree || signTrees.includes(i.ergoTree))
  .reduce((s, i) => s + BigInt(i.value), 0n);
const walletOut = tx.outputs.filter((o) => o.ergoTree === owner.ergoTree).reduce((s, o) => s + BigInt(o.value), 0n);
const fee = tx.outputs.filter((o) => o.ergoTree === FEE_CONTRACT).reduce((s, o) => s + BigInt(o.value), 0n);
const locked = tx.outputs.filter((o) => o.ergoTree !== owner.ergoTree && o.ergoTree !== FEE_CONTRACT);

const headers = await explorer.headers(HEADERS_NEEDED);
const r = reduceTransaction(lib, tx, headers);
const reduced = JSON.parse(lib.ReducedTransaction.sigma_parse_bytes(r.bytes).to_json()) as {
  reducedInputs: { sigmaProp: string }[];
};

const forSigner = {
  inputs: tx.inputs.map((i) => ({ boxId: i.boxId, spendingProof: { proofBytes: "", extension: i.extension ?? {} } })),
  dataInputs: tx.dataInputs.map((d) => ({ boxId: d.boxId })),
  outputs: tx.outputs.map((o) => ({
    value: o.value,
    ergoTree: o.ergoTree,
    creationHeight: o.creationHeight,
    assets: o.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
    additionalRegisters: o.additionalRegisters,
  })),
};
const dir = opt("out") ?? "mainnet-unsigned";
mkdirSync(dir, { recursive: true });
const file = `${dir}/${step}-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}.json`;
writeFileSync(file, JSON.stringify(forSigner, null, 1) + "\n");

console.log(`${step} at height ${height} (explorer ${explorer.base}); tx ${r.txId}`);
console.log(`builder: ${call}`);
console.log(`note: ${note}`);
for (const [k, i] of tx.inputs.entries())
  console.log(
    `  in ${k}: ${i.boxId.slice(0, 12)}… ${erg(BigInt(i.value))}${i.assets.length ? ` +${i.assets.length} tokens` : ""} ${i.ergoTree === owner.ergoTree ? "wallet" : `${i.ergoTree.slice(0, 6)}… (tree v${parseInt(i.ergoTree.slice(0, 2), 16) & 7})`}; reduces to ${reduced.reducedInputs[k].sigmaProp === `cd${ownerPk}` ? "this address's key" : reduced.reducedInputs[k].sigmaProp === "d3" ? "true (keyless)" : reduced.reducedInputs[k].sigmaProp.slice(0, 20) + "…"}`,
  );
for (const [k, o] of tx.outputs.entries())
  console.log(
    `  out ${k}: ${erg(BigInt(o.value))}${o.assets.map((a) => ` ${a.amount}×${a.tokenId.slice(0, 8)}`).join("")} -> ${o.ergoTree === owner.ergoTree ? "wallet" : o.ergoTree === FEE_CONTRACT ? "miner fee" : o.ergoTree.slice(0, 12) + "…"}`,
  );
console.log(
  `miner fee ${erg(fee)}; to other scripts (a contract or another address) ${erg(locked.reduce((s, o) => s + BigInt(o.value), 0n))}; the address's ERG: in ${erg(walletIn)}, back ${erg(walletOut)}, net ${erg(walletOut - walletIn)}`,
);
console.log(`ergopay link ${r.link.length} characters (QR limit ${QR_MAX_CHARS})`);
console.log(`version 2+ inputs: ${lithosHints.v3Inputs.length ? lithosHints.v3Inputs.join(", ") : "none"}`);
console.log(`wrote ${file}`);
if (allowTrees.length) console.log(`--allow-tree ${allowTrees.join(",")}`);
if (signTrees.length) console.log(`--sign-tree ${signTrees.join(",")}`);
