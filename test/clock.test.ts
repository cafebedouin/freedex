// The clocked box against its compiled trees on the mock chain: the preregistered cases of skunks/clockbox/CHARTER.md
// for the buy side (Clock.es), then the same cases mirrored for the sell side (ClockSell.es, the tranche sale).
// The mock chain evaluates at HEIGHT = chain.height + 1, as a node checks the next block (the wallet-signs-at-H,
// node-checks-at-H+1 finding), so "due" is judged against that height. A box's creation height is the build height
// plus one (the first block it can be mined in), so a program built at H has its clock at H + 1.
import { BLOCKCHAIN_PARAMETERS, MockChain, mockBlockchainStateContext } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { SInt, estimateBoxSize } from "@fleet-sdk/serializer";
import { ErgoTree } from "@fleet-sdk/core";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import sigma from "sigmastate-js/main";
import { POOL_TREE, describePool, quote } from "../src/amm";
import {
  CLOCK_SELL_TREE,
  CLOCK_TREE,
  MIN_VALUE_PER_BYTE,
  OWNER_BOX_VALUE,
  RENT_PERIOD,
  STORAGE_FEE_FACTOR,
  buildCancelClock,
  buildCreateClock,
  buildCreateClockSell,
  buildLeg,
  describeClock,
  sizeLeg,
  sizeProgram,
  sizeProgramSell,
} from "../src/clock";
import { FEE } from "../src/orders";

const NFT = "11".repeat(32),
  LP = "22".repeat(32),
  TOKEN = "33".repeat(32);
const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_775_807n;
const SLICE = 10_000_000n; // 0.01 ERG, the buy side's slice
const UNITS = 300n; // the sell side's slice, token units
const EXEC_FEE = 1_500_000n; // 0.0015 ERG
const INTERVAL = 3;

/** The JIT cost sigmastate-js reports for one input's script in a transaction. */
function scriptCost(chain: MockChain, tx: EIP12UnsignedTransaction, input: number): number {
  const ctx = mockBlockchainStateContext({
    headers: { quantity: 10, fromHeight: chain.height, fromTimestamp: Date.now() },
  });
  const { ProverBuilder$ } = sigma as unknown as {
    ProverBuilder$: {
      create(
        p: unknown,
        n: number,
      ): { build(): { reduceTransactionInput(...a: unknown[]): { reductionResult: { cost: number } } } };
    };
  };
  const prover = ProverBuilder$.create(BLOCKCHAIN_PARAMETERS, 0).build();
  return prover.reduceTransactionInput(ctx, tx, tx.inputs, tx.dataInputs, [], input).reductionResult.cost;
}

describe("the clocked box (buy side, Clock.es)", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const owner = chain.newParty("owner");
  const executor = chain.newParty("executor");
  const stranger = chain.newParty("stranger");
  const pool = chain.addParty(POOL_TREE, "pool");
  const clock = chain.addParty(CLOCK_TREE, "clock");
  afterEach(() => chain.reset({ clearParties: true }));

  /** A pool at `price` nanoERG per unit with 1,000 ERG, fee 0.3%. */
  function seedPool(price = 20_000n) {
    pool.addBalance(
      {
        nanoergs: 1_000n * ERG,
        tokens: [
          { tokenId: NFT, amount: 1n },
          { tokenId: LP, amount: LP_MAX - 1_000_000n },
          { tokenId: TOKEN, amount: (1_000n * ERG) / price },
        ],
      },
      { R4: SInt(997).toHex() },
    );
  }

  function create(opts: { legs?: number; toleranceBps?: bigint; maxPrice?: bigint; price?: bigint } = {}) {
    seedPool(opts.price);
    owner.addBalance({ nanoergs: 10n * ERG });
    executor.addBalance({ nanoergs: 1n * ERG });
    stranger.addBalance({ nanoergs: 1n * ERG });
    for (const p of [owner, executor, stranger, pool, clock]) chain.addParty(p);
    const program = {
      owner: owner.address,
      tokenId: TOKEN,
      poolBox: pool.utxos.at(0),
      slice: SLICE,
      interval: INTERVAL,
      toleranceBps: opts.toleranceBps ?? 0n,
      executorFee: EXEC_FEE,
      maxPrice: opts.maxPrice ?? 0n,
      legs: opts.legs ?? 3,
    };
    const sized = sizeProgram(program);
    const built = chain.height;
    const tx = buildCreateClock({ ...program, height: built, inputs: owner.utxos.toArray() });
    expect(chain.execute(tx, { signers: [owner] })).toBe(true);
    const v = describeClock(clock.utxos.at(0));
    expect(v.side).toBe("buy");
    expect(v.owner).toBe(owner.address.encode());
    expect(v.tokenId).toBe(TOKEN);
    expect(v.poolNft).toBe(NFT);
    expect(v.slice).toBe(SLICE);
    expect(v.interval).toBe(BigInt(INTERVAL));
    expect(v.executorFee).toBe(EXEC_FEE);
    expect(v.rentReserve).toBe(0n);
    expect(v.value).toBe(sized.value);
    expect(v.creationHeight).toBe(built + 1); // the first block the box can be mined in
    expect(v.dueAt).toBe(built + 1 + INTERVAL);
    expect(v.legsLeft).toBe(program.legs);
    return { v, built, created: v.creationHeight, sized };
  }

  /** Moves the chain to the first height at which the builder finds the leg due (plus `extra` blocks). */
  const reach = (created: number, extra = 0) => chain.jumpTo(created + INTERVAL + extra);

  const leg = (height = chain.height, force = false) =>
    buildLeg({ height, poolBox: pool.utxos.at(0), clockBox: clock.utxos.at(0), payTo: executor.address }, force);

  it("sizes the program: legs x (slice + fee), no rent reserve on the buy side; refuses a schedule past a rent period", () => {
    seedPool();
    const base = {
      owner: owner.address,
      tokenId: TOKEN,
      poolBox: pool.utxos.at(0),
      slice: SLICE,
      interval: INTERVAL,
      toleranceBps: 0n,
      executorFee: EXEC_FEE,
      maxPrice: 0n,
      legs: 3,
    };
    const s = sizeProgram(base);
    expect(s.rentReserve).toBe(0n);
    expect(s.value).toBe(3n * (SLICE + EXEC_FEE));
    expect(s.rentFeeWouldBe).toBe(BigInt(s.bytes) * STORAGE_FEE_FACTOR);
    console.log(
      `buy program box: ${s.bytes} bytes, locked ${s.value} nanoERG, rent reserve 0 (one rent fee would be ${s.rentFeeWouldBe}); tree ${new ErgoTree(CLOCK_TREE).bytes.length} bytes`,
    );
    expect(() => sizeProgram({ ...base, legs: 2, interval: RENT_PERIOD / 2 + 1 })).toThrow(/storage-rent period/);
    expect(() => sizeProgram({ ...base, legs: 2, interval: RENT_PERIOD / 2 })).not.toThrow();
    expect(() => sizeProgram({ ...base, executorFee: FEE + OWNER_BOX_VALUE })).toThrow(/no one can run a leg/);
    expect(() => sizeProgram({ ...base, legs: 0 })).toThrow(/legs/);
    expect(() => sizeProgram({ ...base, toleranceBps: 10_001n })).toThrow(/tolerance/);
  });

  it("a leg at the interval is accepted: the slice into the pool, the pool's rule to the owner, the fee to the executor, the clock restarted", () => {
    const { v, created } = create();
    expect(leg()).toBeUndefined(); // not due yet
    reach(created);
    const built = leg()!;
    expect(built).toBeDefined();
    const p = describePool(pool.utxos.at(0));
    expect(built.size.amt).toBe(SLICE);
    expect(built.size.got).toBe(quote(p, "erg-to-token", SLICE));
    expect(built.size.payout).toBe(EXEC_FEE - OWNER_BOX_VALUE - FEE);
    expect(estimateBoxSize(built.tx.outputs[1]) * 360).toBeLessThanOrEqual(Number(OWNER_BOX_VALUE)); // the owner's box is above the node's minimum
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
    expect(owner.balance.tokens).toEqual([{ tokenId: TOKEN, amount: built.size.got }]);
    expect(executor.balance.nanoergs).toBe(1n * ERG + built.size.payout);
    expect(describePool(pool.utxos.at(0)).x).toBe(p.x + SLICE);
    const after = describeClock(clock.utxos.at(0));
    expect(after.value).toBe(v.value - SLICE - EXEC_FEE);
    expect(after.legsLeft).toBe(2);
    expect(after.creationHeight).toBe(chain.height); // recreated at the block it was mined in: the clock restarts
    expect(after.rentReserve).toBe(0n);
  });

  it("a program built at H with interval N: its first leg is refused at HEIGHT H+N and accepted at H+N+1", () => {
    const { built } = create();
    // HEIGHT is chain.height + 1: at H+N the box, created at H+1, is one block short of its interval
    chain.jumpTo(built + INTERVAL - 1);
    const early = leg(chain.height, true)!;
    early.tx.outputs[2].creationHeight = built + 1 + INTERVAL; // a successor the successor rule accepts: only `due` refuses
    expect(chain.execute(early.tx, { signers: [], throw: false })).toBe(false);
    chain.jumpTo(built + INTERVAL);
    expect(leg()).toBeUndefined(); // the builder waits for the explorer's height to reach the due height
    const due = leg(chain.height, true)!;
    expect(chain.execute(due.tx, { signers: [] })).toBe(true);
    expect(describeClock(clock.utxos.at(0)).creationHeight).toBe(built + INTERVAL + 1);
  });

  it("one block early is refused by the script, and the builder will not build it", () => {
    const { created } = create();
    reach(created, -2);
    expect(leg()).toBeUndefined();
    // built as if the explorer were two blocks ahead: the node evaluates the next block, HEIGHT = created + interval - 1
    const forced = leg(chain.height + 2, true)!;
    expect(chain.execute(forced.tx, { signers: [], throw: false })).toBe(false);
    reach(created, -1);
    expect(leg()).toBeUndefined();
    expect(clock.utxos.length).toBe(1);
  });

  it("a leg that takes more than the slice is refused", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    // one nanoERG more into the pool, taken from the successor
    tx.outputs[0].value = (BigInt(tx.outputs[0].value) + 1n).toString();
    tx.outputs[2].value = (BigInt(tx.outputs[2].value) - 1n).toString();
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
  });

  it("a fill below tolerance is refused: one token shaved from the owner's output", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    tx.outputs[1].assets[0].amount = (BigInt(tx.outputs[1].assets[0].amount) - 1n).toString();
    tx.outputs[0].assets[2].amount = (BigInt(tx.outputs[0].assets[2].amount) + 1n).toString();
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
  });

  it("with a tolerance, the same shave is accepted", () => {
    const { created } = create({ toleranceBps: 1_000n });
    reach(created);
    const { tx } = leg()!;
    tx.outputs[1].assets[0].amount = (BigInt(tx.outputs[1].assets[0].amount) - 1n).toString();
    tx.outputs[0].assets[2].amount = (BigInt(tx.outputs[0].assets[2].amount) + 1n).toString();
    expect(chain.execute(tx, { signers: [] })).toBe(true);
  });

  it("an executor fee above the cap is refused", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    tx.outputs[3].value = (BigInt(tx.outputs[3].value) + 1n).toString();
    tx.outputs[2].value = (BigInt(tx.outputs[2].value) - 1n).toString();
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
  });

  it("the absolute cap refuses a dear pool and accepts a cheap one", () => {
    // cap 25,000 nanoERG per unit; the pool at 30,000: the builder waits, the script refuses a forced leg
    const dear = create({ maxPrice: 25_000n, price: 30_000n });
    reach(dear.created);
    expect(sizeLeg(describePool(pool.utxos.at(0)), describeClock(clock.utxos.at(0))).priceOk).toBe(false);
    expect(leg()).toBeUndefined();
    const forced = leg(chain.height, true)!;
    expect(chain.execute(forced.tx, { signers: [], throw: false })).toBe(false);
    chain.reset({ clearParties: true });
    // the pool at 20,000: accepted
    const cheap = create({ maxPrice: 25_000n, price: 20_000n });
    reach(cheap.created);
    const built = leg()!;
    expect(built.size.priceOk).toBe(true);
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
  });

  it("the last leg closes the box: no successor, the remainder to the owner", () => {
    const { created } = create({ legs: 2 });
    reach(created);
    const first = leg()!;
    expect(first.size.last).toBe(false);
    expect(chain.execute(first.tx, { signers: [] })).toBe(true);
    const mid = describeClock(clock.utxos.at(0));
    expect(mid.legsLeft).toBe(1);
    expect(mid.last).toBe(true);
    expect(mid.value).toBe(SLICE + EXEC_FEE);
    expect(leg()).toBeUndefined(); // the clock restarted
    reach(mid.creationHeight);
    const second = leg()!;
    expect(second.size.last).toBe(true);
    expect(second.tx.outputs.length).toBe(4); // pool, owner, executor, fee
    expect(second.size.ownerValue).toBe(OWNER_BOX_VALUE); // nothing remains beyond the slice and the fee: a box minimum from the fee
    expect(second.size.payout).toBe(EXEC_FEE - OWNER_BOX_VALUE - FEE);
    const ownerErg = owner.balance.nanoergs;
    expect(chain.execute(second.tx, { signers: [] })).toBe(true);
    expect(clock.utxos.length).toBe(0);
    expect(owner.balance.nanoergs).toBe(ownerErg + OWNER_BOX_VALUE);
    expect(owner.balance.tokens).toEqual([{ tokenId: TOKEN, amount: first.size.got + second.size.got }]);
  });

  it("the owner cancels at any time, everything back less the miner fee", () => {
    const { v } = create();
    const before = owner.balance.nanoergs;
    const tx = buildCancelClock({ height: chain.height, owner: owner.address, clockBox: clock.utxos.at(0) });
    expect(chain.execute(tx, { signers: [owner] })).toBe(true);
    expect(clock.utxos.length).toBe(0);
    expect(owner.balance.nanoergs).toBe(before + v.value - FEE);
  });

  it("a stranger cannot cancel", () => {
    create();
    expect(() =>
      buildCancelClock({ height: chain.height, owner: stranger.address, clockBox: clock.utxos.at(0) }),
    ).toThrow(/only the owner/);
    const tx = buildCancelClock({ height: chain.height, owner: owner.address, clockBox: clock.utxos.at(0) });
    tx.outputs[0].ergoTree = stranger.address.ergoTree;
    expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
    expect(clock.utxos.length).toBe(1);
  });

  it("two clocked boxes in one transaction are refused", () => {
    const { created } = create();
    // a second program of the same owner, created a block later
    const tx2 = buildCreateClock({
      owner: owner.address,
      tokenId: TOKEN,
      poolBox: pool.utxos.at(0),
      slice: SLICE,
      interval: INTERVAL,
      toleranceBps: 0n,
      executorFee: EXEC_FEE,
      maxPrice: 0n,
      legs: 3,
      height: chain.height,
      inputs: owner.utxos.toArray(),
    });
    expect(chain.execute(tx2, { signers: [owner] })).toBe(true);
    expect(clock.utxos.length).toBe(2);
    reach(created, 1);
    const [a, b] = clock.utxos.toArray();
    const built = buildLeg({ height: chain.height, poolBox: pool.utxos.at(0), clockBox: a, payTo: executor.address })!;
    const { tx } = built;
    // the second box joins, claiming the same owner output and successor; its ERG goes to the executor
    tx.inputs.push({
      ...b,
      value: b.value.toString(),
      assets: b.assets.map((t) => ({ ...t, amount: t.amount.toString() })),
      extension: tx.inputs[1].extension,
    });
    tx.outputs[3].value = (BigInt(tx.outputs[3].value) + b.value).toString();
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
    expect(clock.utxos.length).toBe(2);
  });

  it("a backdated successor is refused: legs cannot come faster than the interval", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    expect(tx.outputs[2].creationHeight).toBe(chain.height + 1); // the successor's clock: the block it can be mined in
    tx.outputs[2].creationHeight = created; // the clock as it was: the next leg would be due at once
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
    tx.outputs[2].creationHeight = created + INTERVAL - 1; // one short of the due height
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
    tx.outputs[2].creationHeight = created + INTERVAL; // the due height itself: allowed
    expect(chain.execute(tx, { signers: [] })).toBe(true);
  });

  it("prints the evaluation cost of one leg", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    const clockCost = scriptCost(chain, tx, 1);
    const poolCost = scriptCost(chain, tx, 0);
    console.log(
      `cost of one buy leg: clock script ${clockCost}, pool script ${poolCost}; tree ${new ErgoTree(CLOCK_TREE).bytes.length} bytes`,
    );
    expect(clockCost).toBeGreaterThan(0);
    expect(clockCost).toBeLessThan(100_000);
    expect(chain.execute(tx, { signers: [] })).toBe(true);
  });
});

describe("the tranche sale (sell side, ClockSell.es)", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const owner = chain.newParty("owner");
  const executor = chain.newParty("executor");
  const stranger = chain.newParty("stranger");
  const pool = chain.addParty(POOL_TREE, "pool");
  const clock = chain.addParty(CLOCK_SELL_TREE, "clock");
  afterEach(() => chain.reset({ clearParties: true }));

  function seedPool(price = 20_000n) {
    pool.addBalance(
      {
        nanoergs: 1_000n * ERG,
        tokens: [
          { tokenId: NFT, amount: 1n },
          { tokenId: LP, amount: LP_MAX - 1_000_000n },
          { tokenId: TOKEN, amount: (1_000n * ERG) / price },
        ],
      },
      { R4: SInt(997).toHex() },
    );
  }

  const base = () => ({
    owner: owner.address,
    tokenId: TOKEN,
    poolBox: pool.utxos.at(0),
    tokens: 3n * UNITS,
    slice: UNITS,
    interval: INTERVAL,
    toleranceBps: 0n,
    executorFee: EXEC_FEE,
    minPrice: 0n,
  });

  function create(
    opts: { tokens?: bigint; slice?: bigint; toleranceBps?: bigint; minPrice?: bigint; price?: bigint } = {},
  ) {
    seedPool(opts.price);
    const tokens = opts.tokens ?? 3n * UNITS;
    owner.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: TOKEN, amount: tokens }] });
    executor.addBalance({ nanoergs: 1n * ERG });
    stranger.addBalance({ nanoergs: 1n * ERG });
    for (const p of [owner, executor, stranger, pool, clock]) chain.addParty(p);
    const program = {
      ...base(),
      tokens,
      slice: opts.slice ?? UNITS,
      toleranceBps: opts.toleranceBps ?? 0n,
      minPrice: opts.minPrice ?? 0n,
    };
    const sized = sizeProgramSell(program);
    const built = chain.height;
    const tx = buildCreateClockSell({ ...program, height: built, inputs: owner.utxos.toArray() });
    expect(chain.execute(tx, { signers: [owner] })).toBe(true);
    const v = describeClock(clock.utxos.at(0));
    expect(v.side).toBe("sell");
    expect(v.owner).toBe(owner.address.encode());
    expect(v.tokenId).toBe(TOKEN);
    expect(v.poolNft).toBe(NFT);
    expect(v.slice).toBe(program.slice);
    expect(v.tokens).toBe(tokens);
    expect(v.interval).toBe(BigInt(INTERVAL));
    expect(v.executorFee).toBe(EXEC_FEE);
    expect(v.minPrice).toBe(program.minPrice);
    expect(v.maxPrice).toBe(0n);
    expect(v.rentReserve).toBe(sized.rentReserve);
    expect(v.value).toBe(sized.value);
    expect(v.creationHeight).toBe(built + 1);
    expect(v.legsLeft).toBe(sized.legs);
    expect(owner.balance.tokens).toEqual([]); // every unit is in the box
    return { v, built, created: v.creationHeight, sized };
  }

  const reach = (created: number, extra = 0) => chain.jumpTo(created + INTERVAL + extra);
  const leg = (height = chain.height, force = false) =>
    buildLeg({ height, poolBox: pool.utxos.at(0), clockBox: clock.utxos.at(0), payTo: executor.address }, force);

  it("sizes the program: legs x fee plus one storage-rent fee for the box's bytes plus the node's minimum; legs from the tokens", () => {
    seedPool();
    const s = sizeProgramSell(base());
    expect(s.legs).toBe(3);
    expect(s.rentReserve).toBe(BigInt(s.bytes) * STORAGE_FEE_FACTOR);
    expect(s.minBox).toBe(BigInt(s.bytes) * MIN_VALUE_PER_BYTE);
    expect(s.value).toBe(3n * EXEC_FEE + s.rentReserve + s.minBox);
    console.log(
      `sell program box: ${s.bytes} bytes, rent reserve ${s.rentReserve} nanoERG, minimum ${s.minBox}, locked ${s.value}; tree ${new ErgoTree(CLOCK_SELL_TREE).bytes.length} bytes`,
    );
    expect(sizeProgramSell({ ...base(), tokens: 1_000n }).legs).toBe(3); // 300, 300, then 400 on the last leg
    expect(() => sizeProgramSell({ ...base(), tokens: UNITS - 1n })).toThrow(/at least one slice/);
    expect(() => sizeProgramSell({ ...base(), interval: RENT_PERIOD / 3 + 1 })).toThrow(/storage-rent period/);
    expect(() => sizeProgramSell({ ...base(), executorFee: FEE + OWNER_BOX_VALUE })).toThrow(/no one can run a leg/);
    expect(() => sizeProgramSell({ ...base(), toleranceBps: 10_001n })).toThrow(/tolerance/);
    expect(() => sizeProgramSell({ ...base(), minPrice: -1n })).toThrow(/minPrice/);
  });

  it("a leg at the interval is accepted: the slice into the pool, the pool's rule in ERG to the owner, the fee to the executor, the clock restarted", () => {
    const { v, created } = create();
    expect(leg()).toBeUndefined();
    reach(created);
    const built = leg()!;
    expect(built).toBeDefined();
    const p = describePool(pool.utxos.at(0));
    expect(built.size.side).toBe("sell");
    expect(built.size.amt).toBe(UNITS);
    expect(built.size.got).toBe(quote(p, "token-to-erg", UNITS));
    expect(built.size.got).toBeGreaterThan(OWNER_BOX_VALUE); // no top-up at this size
    expect(built.size.ownerValue).toBe(built.size.got);
    expect(built.size.payout).toBe(EXEC_FEE - FEE);
    const ownerErg = owner.balance.nanoergs;
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
    expect(owner.balance.nanoergs).toBe(ownerErg + built.size.got);
    expect(owner.balance.tokens).toEqual([]);
    expect(executor.balance.nanoergs).toBe(1n * ERG + built.size.payout);
    const after = describePool(pool.utxos.at(0));
    expect(after.x).toBe(p.x - built.size.got);
    expect(after.y).toBe(p.y + UNITS);
    const next = describeClock(clock.utxos.at(0));
    expect(next.value).toBe(v.value - EXEC_FEE);
    expect(next.tokens).toBe(2n * UNITS);
    expect(next.legsLeft).toBe(2);
    expect(next.creationHeight).toBe(chain.height);
    expect(next.rentReserve).toBe(v.rentReserve);
  });

  it("a slice whose proceeds are below the node's minimum: the owner's box is topped up out of the executor's fee", () => {
    const { created } = create({ tokens: 3n, slice: 1n }); // one unit sells for about 20,000 nanoERG
    reach(created);
    const built = leg()!;
    expect(built.size.got).toBeLessThan(OWNER_BOX_VALUE);
    expect(built.size.ownerValue).toBe(OWNER_BOX_VALUE);
    expect(built.size.payout).toBe(EXEC_FEE - (OWNER_BOX_VALUE - built.size.got) - FEE);
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
    expect(describeClock(clock.utxos.at(0)).tokens).toBe(2n);
  });

  it("one block early is refused by the script, and the builder will not build it", () => {
    const { created } = create();
    reach(created, -2);
    expect(leg()).toBeUndefined();
    const forced = leg(chain.height + 2, true)!;
    expect(chain.execute(forced.tx, { signers: [], throw: false })).toBe(false);
    reach(created, -1);
    expect(leg()).toBeUndefined();
    expect(clock.utxos.length).toBe(1);
  });

  it("a leg that sells more than the slice is refused", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    // one unit more into the pool, taken from the successor
    tx.outputs[0].assets[2].amount = (BigInt(tx.outputs[0].assets[2].amount) + 1n).toString();
    tx.outputs[2].assets[0].amount = (BigInt(tx.outputs[2].assets[0].amount) - 1n).toString();
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
  });

  it("a fill below tolerance is refused: one nanoERG shaved from the owner's output", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    tx.outputs[1].value = (BigInt(tx.outputs[1].value) - 1n).toString();
    tx.outputs[3].value = (BigInt(tx.outputs[3].value) + 1n).toString();
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
  });

  it("with a tolerance, the same shave is accepted", () => {
    const { created } = create({ toleranceBps: 1_000n });
    reach(created);
    const { tx } = leg()!;
    tx.outputs[1].value = (BigInt(tx.outputs[1].value) - 1n).toString();
    tx.outputs[3].value = (BigInt(tx.outputs[3].value) + 1n).toString();
    expect(chain.execute(tx, { signers: [] })).toBe(true);
  });

  it("an executor fee above the cap is refused", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    tx.outputs[3].value = (BigInt(tx.outputs[3].value) + 1n).toString();
    tx.outputs[2].value = (BigInt(tx.outputs[2].value) - 1n).toString();
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
  });

  it("the floor refuses a cheap pool and accepts a dear one", () => {
    // floor 25,000 nanoERG per unit; the pool at 20,000: the builder waits, the script refuses a forced leg
    const cheap = create({ minPrice: 25_000n, price: 20_000n });
    reach(cheap.created);
    expect(sizeLeg(describePool(pool.utxos.at(0)), describeClock(clock.utxos.at(0))).priceOk).toBe(false);
    expect(leg()).toBeUndefined();
    const forced = leg(chain.height, true)!;
    expect(chain.execute(forced.tx, { signers: [], throw: false })).toBe(false);
    chain.reset({ clearParties: true });
    // the pool at 30,000: accepted
    const dear = create({ minPrice: 25_000n, price: 30_000n });
    reach(dear.created);
    const built = leg()!;
    expect(built.size.priceOk).toBe(true);
    expect(built.size.got).toBeGreaterThanOrEqual(25_000n * UNITS);
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
  });

  it("the last leg closes the box: no successor, the proceeds, the rent reserve and the minimum to the owner", () => {
    const { v, created, sized } = create({ tokens: 2n * UNITS });
    reach(created);
    const first = leg()!;
    expect(first.size.last).toBe(false);
    expect(chain.execute(first.tx, { signers: [] })).toBe(true);
    const mid = describeClock(clock.utxos.at(0));
    expect(mid.legsLeft).toBe(1);
    expect(mid.last).toBe(true);
    expect(mid.value).toBe(EXEC_FEE + v.rentReserve + sized.minBox);
    expect(leg()).toBeUndefined(); // the clock restarted
    reach(mid.creationHeight);
    const second = leg()!;
    expect(second.size.last).toBe(true);
    expect(second.size.amt).toBe(UNITS);
    expect(second.tx.outputs.length).toBe(4); // pool, owner, executor, fee
    expect(second.size.ownerValue).toBe(second.size.got + v.rentReserve + sized.minBox);
    expect(second.size.payout).toBe(EXEC_FEE - FEE);
    const ownerErg = owner.balance.nanoergs;
    expect(chain.execute(second.tx, { signers: [] })).toBe(true);
    expect(clock.utxos.length).toBe(0);
    expect(owner.balance.nanoergs).toBe(ownerErg + second.size.got + v.rentReserve + sized.minBox);
    expect(owner.balance.tokens).toEqual([]);
    expect(describePool(pool.utxos.at(0)).y).toBe((1_000n * ERG) / 20_000n + 2n * UNITS);
  });

  it("a remainder smaller than a slice is sold with the last leg", () => {
    const { created } = create({ tokens: 1_000n });
    expect(describeClock(clock.utxos.at(0)).legsLeft).toBe(3);
    reach(created);
    expect(chain.execute(leg()!.tx, { signers: [] })).toBe(true);
    reach(describeClock(clock.utxos.at(0)).creationHeight);
    expect(chain.execute(leg()!.tx, { signers: [] })).toBe(true);
    const lastView = describeClock(clock.utxos.at(0));
    expect(lastView.tokens).toBe(400n);
    expect(lastView.last).toBe(true);
    reach(lastView.creationHeight);
    const last = leg()!;
    expect(last.size.amt).toBe(400n);
    expect(chain.execute(last.tx, { signers: [] })).toBe(true);
    expect(clock.utxos.length).toBe(0);
  });

  it("the owner cancels at any time, the tokens and the ERG back less the miner fee", () => {
    const { v } = create();
    const before = owner.balance.nanoergs;
    const tx = buildCancelClock({ height: chain.height, owner: owner.address, clockBox: clock.utxos.at(0) });
    expect(chain.execute(tx, { signers: [owner] })).toBe(true);
    expect(clock.utxos.length).toBe(0);
    expect(owner.balance.nanoergs).toBe(before + v.value - FEE);
    expect(owner.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 3n * UNITS }]);
  });

  it("a stranger cannot cancel", () => {
    create();
    expect(() =>
      buildCancelClock({ height: chain.height, owner: stranger.address, clockBox: clock.utxos.at(0) }),
    ).toThrow(/only the owner/);
    const tx = buildCancelClock({ height: chain.height, owner: owner.address, clockBox: clock.utxos.at(0) });
    tx.outputs[0].ergoTree = stranger.address.ergoTree;
    expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
    expect(clock.utxos.length).toBe(1);
  });

  it("two sell boxes in one transaction are refused", () => {
    const { created } = create();
    owner.addBalance({ tokens: [{ tokenId: TOKEN, amount: 3n * UNITS }] });
    const tx2 = buildCreateClockSell({ ...base(), height: chain.height, inputs: owner.utxos.toArray() });
    expect(chain.execute(tx2, { signers: [owner] })).toBe(true);
    expect(clock.utxos.length).toBe(2);
    reach(created, 1);
    const [a, b] = clock.utxos.toArray();
    const { tx } = buildLeg({ height: chain.height, poolBox: pool.utxos.at(0), clockBox: a, payTo: executor.address })!;
    // the second box joins, claiming the same owner output and successor; its ERG and tokens go to the executor
    tx.inputs.push({
      ...b,
      value: b.value.toString(),
      assets: b.assets.map((t) => ({ ...t, amount: t.amount.toString() })),
      extension: tx.inputs[1].extension,
    });
    tx.outputs[3].value = (BigInt(tx.outputs[3].value) + b.value).toString();
    tx.outputs[3].assets = b.assets.map((t) => ({ ...t, amount: t.amount.toString() }));
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
    expect(clock.utxos.length).toBe(2);
  });

  it("a backdated successor is refused: legs cannot come faster than the interval", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    tx.outputs[2].creationHeight = created;
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
    tx.outputs[2].creationHeight = created + INTERVAL - 1;
    expect(chain.execute(tx, { signers: [], throw: false })).toBe(false);
    tx.outputs[2].creationHeight = created + INTERVAL;
    expect(chain.execute(tx, { signers: [] })).toBe(true);
  });

  it("prints the evaluation cost of one leg", () => {
    const { created } = create();
    reach(created);
    const { tx } = leg()!;
    const clockCost = scriptCost(chain, tx, 1);
    const poolCost = scriptCost(chain, tx, 0);
    console.log(
      `cost of one sell leg: clock script ${clockCost}, pool script ${poolCost}; tree ${new ErgoTree(CLOCK_SELL_TREE).bytes.length} bytes`,
    );
    expect(clockCost).toBeGreaterThan(0);
    expect(clockCost).toBeLessThan(100_000);
    expect(chain.execute(tx, { signers: [] })).toBe(true);
  });
});
