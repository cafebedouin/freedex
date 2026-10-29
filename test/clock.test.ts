// The clocked box against its compiled tree on the mock chain: the preregistered cases of skunks/clockbox/CHARTER.md.
// The mock chain evaluates at HEIGHT = chain.height + 1, as a node checks the next block (the wallet-signs-at-H,
// node-checks-at-H+1 finding), so "due" is judged against that height.
import { BLOCKCHAIN_PARAMETERS, MockChain, mockBlockchainStateContext } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { SInt, estimateBoxSize } from "@fleet-sdk/serializer";
import { ErgoTree } from "@fleet-sdk/core";
import sigma from "sigmastate-js/main";
import { POOL_TREE, describePool, quote } from "../src/amm";
import {
  CLOCK_TREE,
  OWNER_BOX_VALUE,
  RENT_PERIOD,
  STORAGE_FEE_FACTOR,
  buildCancelClock,
  buildCreateClock,
  buildLeg,
  describeClock,
  sizeLeg,
  sizeProgram,
} from "../src/clock";
import { FEE } from "../src/orders";

const NFT = "11".repeat(32),
  LP = "22".repeat(32),
  TOKEN = "33".repeat(32);
const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_775_807n;
const SLICE = 10_000_000n; // 0.01 ERG
const EXEC_FEE = 1_500_000n; // 0.0015 ERG
const INTERVAL = 3;

describe("the clocked box", () => {
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
    const tx = buildCreateClock({ ...program, height: chain.height, inputs: owner.utxos.toArray() });
    const created = chain.height; // the box's creation height
    expect(chain.execute(tx, { signers: [owner] })).toBe(true);
    const v = describeClock(clock.utxos.at(0));
    expect(v.owner).toBe(owner.address.encode());
    expect(v.tokenId).toBe(TOKEN);
    expect(v.poolNft).toBe(NFT);
    expect(v.slice).toBe(SLICE);
    expect(v.interval).toBe(BigInt(INTERVAL));
    expect(v.executorFee).toBe(EXEC_FEE);
    expect(v.rentReserve).toBe(sized.rentReserve);
    expect(v.value).toBe(sized.value);
    expect(v.creationHeight).toBe(created);
    expect(v.legsLeft).toBe(program.legs);
    return { v, created, sized };
  }

  /** Moves the chain to the first height at which the builder finds the leg due (plus `extra` blocks). */
  const reach = (created: number, extra = 0) => chain.jumpTo(created + INTERVAL + extra);

  const leg = (height = chain.height, force = false) =>
    buildLeg({ height, poolBox: pool.utxos.at(0), clockBox: clock.utxos.at(0), payTo: executor.address }, force);

  it("sizes the program: legs x (slice + fee) plus one storage-rent fee for the box's bytes; refuses a schedule past a rent period", () => {
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
    expect(s.rentReserve).toBe(BigInt(s.bytes) * STORAGE_FEE_FACTOR);
    expect(s.value).toBe(3n * (SLICE + EXEC_FEE) + s.rentReserve);
    console.log(
      `program box: ${s.bytes} bytes, rent reserve ${s.rentReserve} nanoERG; tree ${new ErgoTree(CLOCK_TREE).bytes.length} bytes`,
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
    expect(after.creationHeight).toBe(chain.height - 1); // recreated at the height it was built: the clock restarts
    expect(after.rentReserve).toBe(v.rentReserve);
  });

  it("one block early is refused by the script, and the builder will not build it", () => {
    const { created } = create();
    reach(created, -2);
    expect(leg()).toBeUndefined();
    // built as if the explorer were two blocks ahead: the node evaluates the next block, HEIGHT = created + interval - 1
    const forced = leg(chain.height + 2, true)!;
    expect(chain.execute(forced.tx, { signers: [], throw: false })).toBe(false);
    reach(created, -1);
    expect(leg()).toBeUndefined(); // the builder waits for the explorer's height to reach the due height
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
    expect(sizeLeg(describePool(pool.utxos.at(0)), describeClock(clock.utxos.at(0))).capOk).toBe(false);
    expect(leg()).toBeUndefined();
    const forced = leg(chain.height, true)!;
    expect(chain.execute(forced.tx, { signers: [], throw: false })).toBe(false);
    chain.reset({ clearParties: true });
    // the pool at 20,000: accepted
    const cheap = create({ maxPrice: 25_000n, price: 20_000n });
    reach(cheap.created);
    const built = leg()!;
    expect(built.size.capOk).toBe(true);
    expect(chain.execute(built.tx, { signers: [] })).toBe(true);
  });

  it("the last leg closes the box: no successor, the remainder and the rent reserve to the owner", () => {
    const { v, created } = create({ legs: 2 });
    reach(created);
    const first = leg()!;
    expect(first.size.last).toBe(false);
    expect(chain.execute(first.tx, { signers: [] })).toBe(true);
    const mid = describeClock(clock.utxos.at(0));
    expect(mid.legsLeft).toBe(1);
    expect(mid.last).toBe(true);
    expect(leg()).toBeUndefined(); // the clock restarted
    reach(mid.creationHeight);
    const second = leg()!;
    expect(second.size.last).toBe(true);
    expect(second.tx.outputs.length).toBe(4); // pool, owner, executor, fee
    expect(second.size.ownerValue).toBe(v.rentReserve); // what remains after the slice and the fee
    expect(second.size.payout).toBe(EXEC_FEE - FEE);
    const ownerErg = owner.balance.nanoergs;
    expect(chain.execute(second.tx, { signers: [] })).toBe(true);
    expect(clock.utxos.length).toBe(0);
    expect(owner.balance.nanoergs).toBe(ownerErg + v.rentReserve); // the first leg's box minimum was already theirs
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
    const clockCost = prover.reduceTransactionInput(ctx, tx, tx.inputs, tx.dataInputs, [], 1).reductionResult.cost;
    const poolCost = prover.reduceTransactionInput(ctx, tx, tx.inputs, tx.dataInputs, [], 0).reductionResult.cost;
    console.log(
      `cost of one leg: clock script ${clockCost}, pool script ${poolCost}; tree ${new ErgoTree(CLOCK_TREE).bytes.length} bytes`,
    );
    expect(clockCost).toBeGreaterThan(0);
    expect(clockCost).toBeLessThan(100_000);
    expect(chain.execute(tx, { signers: [] })).toBe(true);
  });
});
