// Keyless chain upkeep from the page: jobs that find boxes anyone may act on for a bounty, build the transaction
// with no signature, and submit it through the explorer, the bounty to the visitor's address. Nothing here touches
// the visitor's own boxes or their wallet. Each job is written once and runs the same in a Node sidecar.
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import type { ErgoAddress } from "@fleet-sdk/core";
import { blake2b256, hex } from "@fleet-sdk/crypto";
import { serializeTransaction } from "@fleet-sdk/serializer";
import { describePool } from "./amm.ts";
import { buildBabelTake, describeBabel } from "./babel.ts";
import { SIGMAFI_TEMPLATES, describeBond, type BondView } from "./bonds.ts";
import { CLOCK_SELL_TEMPLATE_SHA256, CLOCK_TEMPLATE_SHA256, buildLeg, describeClock } from "./clock.ts";
import type { Explorer } from "./explorer.ts";
import { buildOrderTake } from "./machina-arb.ts";
import { FEE, describe as describeOrder } from "./orders.ts";

/** The deepest ERG pool per token id. */
async function deepestPools(explorer: Explorer): Promise<Map<string, Box<bigint>>> {
  const deepest = new Map<string, Box<bigint>>();
  for (const p of await explorer.pools(500)) {
    const v = describePool(p.box);
    const cur = deepest.get(v.tokenId);
    if (!cur || BigInt(cur.value) < v.x) deepest.set(v.tokenId, p.box);
  }
  return deepest;
}

export interface UpkeepCandidate {
  job: string;
  /** one line for the log */
  what: string;
  /** nanoERG to the visitor after the miner fee */
  bounty: bigint;
  tx: EIP12UnsignedTransaction;
}

export interface UpkeepJob {
  name: string;
  find(explorer: Explorer, height: number, payTo: ErgoAddress): Promise<UpkeepCandidate[]>;
}

/** Babel bids above their token's deepest ERG pool: buy from the pool, sell to the bid, keep the gap. */
export const babelVsPool: UpkeepJob = {
  name: "babel-vs-pool",
  async find(explorer, height, payTo) {
    const [babels, deepest] = await Promise.all([explorer.babelBoxes(500), deepestPools(explorer)]);
    const out: UpkeepCandidate[] = [];
    for (const babelBox of babels) {
      let b;
      try {
        b = describeBabel(babelBox);
      } catch {
        continue;
      }
      const poolBox = deepest.get(b.tokenId);
      if (!poolBox) continue;
      const built = buildBabelTake({ height, poolBox, babelBox, payTo });
      if (!built) continue;
      out.push({
        job: this.name,
        what: `Babel bid ${b.boxId.slice(0, 8)} on ${b.tokenId.slice(0, 8)}: ${built.take.t} units through the pool, ${built.take.payout} nanoERG to you`,
        bounty: built.take.payout,
        tx: built.tx,
      });
    }
    return out.sort((a, b) => (b.bounty > a.bounty ? 1 : -1));
  },
};

/** Machina limit orders priced across their token's deepest ERG pool, either side. */
export const ordersVsPool: UpkeepJob = {
  name: "orders-vs-pool",
  async find(explorer, height, payTo) {
    const [orders, deepest] = await Promise.all([explorer.limitOrders(200), deepestPools(explorer)]);
    const out: UpkeepCandidate[] = [];
    for (const orderBox of orders) {
      let o;
      try {
        o = describeOrder(orderBox);
      } catch {
        continue;
      }
      const poolBox = deepest.get(o.tokenId);
      if (!poolBox) continue;
      let built;
      try {
        built = buildOrderTake({ height, poolBox, orderBox, payTo });
      } catch {
        continue;
      }
      if (!built) continue;
      out.push({
        job: this.name,
        what: `order ${o.boxId.slice(0, 8)} on ${o.tokenId.slice(0, 8)} (${o.takerAction === "sell" ? "buys" : "sells"} at ${o.price}): ${built.take.t} units through the pool, ${built.take.payout} nanoERG to you`,
        bounty: built.take.payout,
        tx: built.tx,
      });
    }
    return out.sort((a, b) => (b.bounty > a.bounty ? 1 : -1));
  },
};

/**
 * Clocked boxes of both sides (contracts/Clock.es buys, contracts/ClockSell.es sells) whose interval has passed: one
 * leg each against the program's own pool, the tokens or the ERG to the owner, the executor fee to the visitor.
 * `buildLeg` declines a leg that is not due, is outside the program's price bound (the buy side's cap, the sell
 * side's floor), or whose fee does not cover the miner fee and the owner's output.
 */
export const clockLegs: UpkeepJob = {
  name: "clock-legs",
  async find(explorer, height, payTo) {
    const [buys, sells] = await Promise.all([
      explorer.byTemplate(CLOCK_TEMPLATE_SHA256, 500),
      explorer.byTemplate(CLOCK_SELL_TEMPLATE_SHA256, 500),
    ]);
    const boxes = [...buys, ...sells];
    const out: UpkeepCandidate[] = [];
    for (const clockBox of boxes) {
      let v;
      try {
        v = describeClock(clockBox);
      } catch {
        continue;
      }
      if (height < v.dueAt) continue;
      let built;
      try {
        const poolBox = (await explorer.poolByNft(v.poolNft)).box;
        built = buildLeg({ height, poolBox, clockBox, payTo });
      } catch {
        continue;
      }
      if (!built) continue;
      out.push({
        job: this.name,
        what:
          v.side === "buy"
            ? `program ${v.boxId.slice(0, 8)} on ${v.tokenId.slice(0, 8)}: ${built.size.amt} nanoERG for ${built.size.got} units to its owner${built.size.last ? ", the last leg" : ""}, ${built.size.payout} nanoERG to you`
            : `sell program ${v.boxId.slice(0, 8)} on ${v.tokenId.slice(0, 8)}: ${built.size.amt} units for ${built.size.got} nanoERG to its owner${built.size.last ? ", the last leg" : ""}, ${built.size.payout} nanoERG to you`,
        bounty: built.size.payout,
        tx: built.tx,
      });
    }
    return out.sort((a, b) => (b.bounty > a.bounty ? 1 : -1));
  },
};

export const JOBS: UpkeepJob[] = [babelVsPool, ordersVsPool, clockLegs];

/**
 * Matured SigmaFi bonds whose lender is one of `addresses` and whose collateral is worth more than the miner fee:
 * the liquidation path is keyless, but the fee must come from the lender's own boxes, so this is not a JOBS entry;
 * the page builds `buildLiquidate` with the visitor's wallet when the visitor is that lender.
 */
export async function maturedBondsFor(
  explorer: Explorer,
  height: number,
  addresses: string[],
): Promise<{ box: Box<bigint>; v: BondView }[]> {
  if (addresses.length === 0) return [];
  const [b1, b2] = await Promise.all([
    explorer.byTemplate(SIGMAFI_TEMPLATES.bondErg),
    explorer.byTemplate(SIGMAFI_TEMPLATES.bondToken),
  ]);
  const out: { box: Box<bigint>; v: BondView }[] = [];
  for (const box of [...b1, ...b2]) {
    let v: BondView;
    try {
      v = describeBond(box);
    } catch {
      continue;
    }
    if (!addresses.includes(v.lender) || height < v.maturity) continue;
    if (v.collateralTokens.length === 0 && BigInt(box.value) <= FEE) continue;
    out.push({ box, v });
  }
  return out;
}

/** Node JSON for a transaction none of whose inputs needs a proof. */
export function keylessJson(tx: EIP12UnsignedTransaction): { id: string; json: string } {
  // the id is the hash of the transaction without proofs, which is what the wallet-less transaction is
  const bytes = serializeTransaction({
    inputs: tx.inputs.map((i) => ({ boxId: i.boxId, extension: i.extension ?? {} })),
    dataInputs: tx.dataInputs.map((d) => ({ boxId: d.boxId })),
    outputs: tx.outputs.map((o) => ({
      value: o.value,
      ergoTree: o.ergoTree,
      creationHeight: o.creationHeight,
      assets: o.assets,
      additionalRegisters: o.additionalRegisters,
    })),
  }).toBytes();
  const id = hex.encode(blake2b256(bytes));
  const big = (v: string) => {
    const raw = (JSON as unknown as { rawJSON?: (s: string) => unknown }).rawJSON;
    if (raw) return raw(v);
    if (Number.isSafeInteger(Number(v))) return Number(v);
    throw new Error(`integer ${v} too large for this browser's JSON`);
  };
  const signed = {
    id,
    inputs: tx.inputs.map((i) => ({ boxId: i.boxId, spendingProof: { proofBytes: "", extension: i.extension ?? {} } })),
    dataInputs: tx.dataInputs.map((d) => ({ boxId: d.boxId })),
    outputs: tx.outputs.map((o) => ({
      value: big(o.value),
      ergoTree: o.ergoTree,
      creationHeight: o.creationHeight,
      assets: o.assets.map((a) => ({ tokenId: a.tokenId, amount: big(a.amount) })),
      additionalRegisters: o.additionalRegisters,
    })),
  };
  return { id, json: JSON.stringify(signed) };
}

/** How long a box an upkeep transaction spent is left alone afterwards: the explorer lists it as unspent until the block. */
export const RECENT_MS = 10 * 60 * 1000;

/**
 * Run every job once; submit each candidate; report what happened. Candidates sharing an input are tried in order.
 * `recent` (box id to the time it was spent) carries across runs so a box whose transaction is still in the mempool
 * is not spent twice; the caller keeps it.
 */
export async function runUpkeep(
  explorer: Explorer,
  payTo: ErgoAddress,
  log: (m: string) => void,
  recent: Map<string, number> = new Map(),
): Promise<{ found: number; submitted: string[] }> {
  const height = await explorer.height();
  const submitted: string[] = [];
  let found = 0;
  const now = Date.now();
  for (const [id, at] of recent) if (now - at > RECENT_MS) recent.delete(id);
  const spent = new Set<string>(recent.keys());
  for (const job of JOBS) {
    let cands: UpkeepCandidate[];
    try {
      cands = await job.find(explorer, height, payTo);
    } catch (e) {
      log(`upkeep ${job.name}: ${(e as Error).message}`);
      continue;
    }
    found += cands.length;
    for (const c of cands) {
      if (c.tx.inputs.some((i) => spent.has(i.boxId))) continue;
      try {
        const { id, json } = keylessJson(c.tx);
        await explorer.submit(json);
        for (const i of c.tx.inputs) {
          spent.add(i.boxId);
          recent.set(i.boxId, now);
        }
        submitted.push(id);
        log(`upkeep ${c.job}: ${c.what}; submitted ${id}`);
      } catch (e) {
        log(`upkeep ${c.job}: ${c.what}; not submitted (${(e as Error).message})`);
      }
    }
  }
  return { found, submitted };
}
