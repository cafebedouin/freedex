// A small mainnet in miniature on the mock chain: pools, a bank, orders, Babel boxes, loans and escrows, with real
// whitelist token ids so the page's static lists and the live listings agree.
import { MockChain } from "@fleet-sdk/mock-chain";
import { SIGMA_USD_PARAMETERS } from "@fleet-sdk/ageusd-plugin";
import { SGroupElement, SInt, SLong, SSigmaProp } from "@fleet-sdk/serializer";
import { POOL_TREE, T2T_POOL_TREE } from "../../src/protocols/ergodex/amm";
import { babelTree } from "../../src/protocols/babel/babel";
import { CLOCK_SELL_TREE, CLOCK_TREE, buildCreateClock, buildCreateClockSell } from "../../src/protocols/clock/clock";
import { bondContract, buildLend, buildOpenOrder, orderContract } from "../../src/protocols/sigmafi/bonds";
import { ESCROW_TREE, buildCreateEscrow } from "../../src/protocols/tokenjay/escrow";
import { CALL_TREE, PUT_TREE, buildBuy as buildOptionBuy, buildWrite } from "../../src/protocols/option/option";
import { buildCreate } from "../../src/protocols/machina/orders";
import { LimitOrder } from "@nautls/machinafi-sdk";
import tokenlist from "../../src/tokenlist.json" with { type: "json" };
import type { World } from "./harness";

const ERG = 1_000_000_000n;
const LP_MAX = 9_223_372_036_854_775_807n;
const P = SIGMA_USD_PARAMETERS;
const byName = (name: string) => tokenlist.tokens.find((t) => t.name === name)!;

export const SIGUSD = byName("SigUSD").id; // 2 decimals
export const RSBTC = byName("rsBTC").id; // 8 decimals
export const RSN = byName("RSN").id; // 3 decimals
export const RSFIRO = byName("rsFIRO").id; // no pool in this world
export const NFT1 = "a1".repeat(32);
export const NFT2 = "a2".repeat(32);
export const NFT3 = "a3".repeat(32);
const LP1 = "b1".repeat(32),
  LP2 = "b2".repeat(32),
  LP3 = "b3".repeat(32);

export function makeWorld() {
  const chain = new MockChain({ height: 1_900_000 });
  const me = chain.newParty("me");
  const stranger = chain.newParty("stranger");
  const other = chain.newParty("other");
  me.addBalance({
    nanoergs: 100n * ERG,
    tokens: [
      { tokenId: SIGUSD, amount: 10_000n },
      { tokenId: RSBTC, amount: 100_000_000n },
    ],
  });
  stranger.addBalance({
    nanoergs: 100n * ERG,
    tokens: [
      { tokenId: SIGUSD, amount: 100_000n },
      { tokenId: RSN, amount: 5_000n },
    ],
  });
  other.addBalance({ nanoergs: 100n * ERG, tokens: [{ tokenId: SIGUSD, amount: 100_000n }] });

  // ERG pools: SigUSD at 0.05 ERG per SigUSD (1000 ERG / 20,000 SigUSD), RSN; a direct SigUSD/rsBTC pool
  const poolSigUsd = chain.addParty(POOL_TREE, "pool SigUSD");
  poolSigUsd.addBalance(
    {
      nanoergs: 1_000n * ERG,
      tokens: [
        { tokenId: NFT1, amount: 1n },
        { tokenId: LP1, amount: LP_MAX - 1_000_000n },
        { tokenId: SIGUSD, amount: 2_000_000n },
      ],
    },
    { R4: SInt(997).toHex() },
  );
  const poolRsn = chain.addParty(POOL_TREE, "pool RSN");
  poolRsn.addBalance(
    {
      nanoergs: 500n * ERG,
      tokens: [
        { tokenId: NFT3, amount: 1n },
        { tokenId: LP3, amount: LP_MAX - 1_000_000n },
        { tokenId: RSN, amount: 5_000_000n },
      ],
    },
    { R4: SInt(997).toHex() },
  );
  const poolT2T = chain.addParty(T2T_POOL_TREE, "pool SigUSD/rsBTC");
  poolT2T.addBalance(
    {
      nanoergs: 10_000_000n,
      tokens: [
        { tokenId: NFT2, amount: 1n },
        { tokenId: LP2, amount: LP_MAX - 1_000_000n },
        { tokenId: SIGUSD, amount: 1_000_000n },
        { tokenId: RSBTC, amount: 100_000_000n },
      ],
    },
    { R4: SInt(997).toHex() },
  );

  // the bank: 2,000,000 ERG, 100,000 SigUSD and 10,000,000 SigRSV out, 1 USD = 3 ERG (ratio 667%)
  const bank = chain.addParty(P.contract, "bank");
  bank.addBalance(
    {
      nanoergs: 2_000_000n * ERG,
      tokens: [
        { tokenId: P.tokens.stableCoinId, amount: 10_000_000_000_000n - 10_000_000n },
        { tokenId: P.tokens.reserveCoinId, amount: 10_000_000_000_000n - 10_000_000n },
        { tokenId: P.tokens.nftId, amount: 1n },
      ],
    },
    { R4: SLong(10_000_000n).toHex(), R5: SLong(10_000_000n).toHex() },
  );
  const oracle = chain.newParty("oracle");
  oracle.addBalance(
    { nanoergs: 1n * ERG, tokens: [{ tokenId: P.oracle.nftId, amount: 1n }] },
    { R4: SLong(3_000_000_000n).toHex() },
  );

  // Machina orders on SigUSD: a stranger sells at 0.05 and 0.04 ERG per SigUSD (takers buy), buys at 0.03 (takers sell)
  const orderTree = (owner: typeof stranger) =>
    LimitOrder.create({
      owner: owner.address,
      type: "buy",
      price: 1n,
      assets: { base: { tokenId: "ERG", amount: 0n }, quote: { tokenId: SIGUSD, amount: 1n } },
    }).ergoTree;
  const ordersStranger = chain.addParty(orderTree(stranger), "orders of stranger");
  const ordersMe = chain.addParty(orderTree(me), "orders of me");
  const parties = [me, stranger, other, poolSigUsd, poolRsn, poolT2T, bank, oracle, ordersStranger, ordersMe];
  for (const p of parties) chain.addParty(p);
  const run = (tx: Parameters<typeof chain.execute>[0], signer: typeof me) => {
    if (!chain.execute(tx, { signers: [signer] })) throw new Error("fixture transaction refused");
  };
  run(
    buildCreate({
      height: chain.height,
      inputs: stranger.utxos.toArray(),
      owner: stranger.address,
      side: "sell-tokens",
      quoteTokenId: SIGUSD,
      price: 5_000_000n,
      tokenAmount: 1_000n,
    }),
    stranger,
  );
  run(
    buildCreate({
      height: chain.height,
      inputs: stranger.utxos.toArray(),
      owner: stranger.address,
      side: "sell-tokens",
      quoteTokenId: SIGUSD,
      price: 4_000_000n,
      tokenAmount: 500n,
    }),
    stranger,
  );
  run(
    buildCreate({
      height: chain.height,
      inputs: stranger.utxos.toArray(),
      owner: stranger.address,
      side: "buy-tokens",
      quoteTokenId: SIGUSD,
      price: 3_000_000n,
      ergAmount: 1n * ERG,
    }),
    stranger,
  );
  // and one of the visitor's own: selling rsBTC
  const ordersMeBtc = chain.addParty(
    LimitOrder.create({
      owner: me.address,
      type: "buy",
      price: 1n,
      assets: { base: { tokenId: "ERG", amount: 0n }, quote: { tokenId: RSBTC, amount: 1n } },
    }).ergoTree,
    "rsBTC orders of me",
  );
  chain.addParty(ordersMeBtc);
  parties.push(ordersMeBtc);
  run(
    buildCreate({
      height: chain.height,
      inputs: me.utxos.toArray(),
      owner: me.address,
      side: "sell-tokens",
      quoteTokenId: RSBTC,
      price: 1_000n,
      tokenAmount: 50_000_000n,
    }),
    me,
  );

  // a Babel bid on SigUSD at 0.035 ERG per SigUSD with 1 ERG: takers sell into it
  const babel = chain.addParty(babelTree(SIGUSD), "babel SigUSD");
  babel.addBalance(
    { nanoergs: 1n * ERG },
    { R4: SSigmaProp(SGroupElement(other.key.publicKey)).toHex(), R5: SLong(3_500_000n).toHex() },
  );
  chain.addParty(babel);
  parties.push(babel);

  // SigmaFi: a stranger's open loan request; a loan the visitor lent to the stranger, matured; a request of the visitor's own
  const loanOrders = chain.addParty(orderContract("ERG"), "sigmafi orders");
  const bonds = chain.addParty(bondContract("ERG"), "sigmafi bonds");
  chain.addParty(loanOrders);
  chain.addParty(bonds);
  parties.push(loanOrders, bonds);
  run(
    buildOpenOrder({
      height: chain.height,
      inputs: stranger.utxos.toArray(),
      borrower: stranger.address,
      principalId: "ERG",
      principal: 2n * ERG,
      repayment: 2_100_000_000n,
      term: 100,
      collateralErg: 5n * ERG,
    }),
    stranger,
  );
  run(
    buildLend({
      height: chain.height,
      inputs: me.utxos.toArray(),
      lender: me.address,
      orderBox: loanOrders.utxos.at(0),
    }),
    me,
  );
  run(
    buildOpenOrder({
      height: chain.height,
      inputs: other.utxos.toArray(),
      borrower: other.address,
      principalId: "ERG",
      principal: 3n * ERG,
      repayment: 3_300_000_000n,
      term: 1_000,
      collateralErg: 7n * ERG,
    }),
    other,
  );
  run(
    buildOpenOrder({
      height: chain.height,
      inputs: me.utxos.toArray(),
      borrower: me.address,
      principalId: "ERG",
      principal: 1n * ERG,
      repayment: 1_050_000_000n,
      term: 720,
      collateralErg: 3n * ERG,
    }),
    me,
  );
  // clocked programs on RSN (a pool no other upkeep job contends for): the stranger's, due after the jump below,
  // and the visitor's own
  const programs = chain.addParty(CLOCK_TREE, "programs");
  chain.addParty(programs);
  parties.push(programs);
  const program = {
    tokenId: RSN,
    poolBox: poolRsn.utxos.at(0),
    slice: 100_000_000n,
    interval: 10,
    toleranceBps: 50n,
    executorFee: 1_500_000n,
    maxPrice: 0n,
    legs: 3,
  };
  run(
    buildCreateClock({ ...program, owner: stranger.address, height: chain.height, inputs: stranger.utxos.toArray() }),
    stranger,
  );
  run(
    buildCreateClock({
      ...program,
      interval: 720,
      owner: me.address,
      height: chain.height,
      inputs: me.utxos.toArray(),
    }),
    me,
  );
  // the stranger's tranche sale on RSN, not due for a day: listed, not executed
  const programsSell = chain.addParty(CLOCK_SELL_TREE, "sell programs");
  chain.addParty(programsSell);
  parties.push(programsSell);
  run(
    buildCreateClockSell({
      owner: stranger.address,
      tokenId: RSN,
      poolBox: poolRsn.utxos.at(0),
      tokens: 3_000n,
      slice: 1_000n,
      interval: 720,
      toleranceBps: 50n,
      executorFee: 1_500_000n,
      minPrice: 0n,
      height: chain.height,
      inputs: stranger.utxos.toArray(),
    }),
    stranger,
  );
  chain.jumpTo(chain.height + 101); // the lent bond has matured, the stranger's buy program is due

  // escrows: the stranger offers 10 SigUSD units to the visitor at 0.002 ERG; another between strangers
  const escrows = chain.addParty(ESCROW_TREE, "escrows");
  chain.addParty(escrows);
  parties.push(escrows);
  run(
    buildCreateEscrow({
      height: chain.height,
      inputs: stranger.utxos.toArray(),
      seller: stranger.address,
      buyer: me.address,
      tokenId: SIGUSD,
      amount: 10n,
      price: 2_000_000n,
    }),
    stranger,
  );
  run(
    buildCreateEscrow({
      height: chain.height,
      inputs: stranger.utxos.toArray(),
      seller: stranger.address,
      buyer: other.address,
      tokenId: SIGUSD,
      amount: 20n,
      price: 4_000_000n,
    }),
    stranger,
  );

  // options (SK-065) on SigUSD: the stranger's unsold call offer; a call the visitor bought from the stranger; a call
  // the visitor wrote that expires 50 blocks from here (the options UI test moves the world past it); the stranger's
  // unsold put offer
  const calls = chain.addParty(CALL_TREE, "calls");
  const puts = chain.addParty(PUT_TREE, "puts");
  chain.addParty(calls);
  chain.addParty(puts);
  parties.push(calls, puts);
  const callTerms = { side: "call" as const, tokenId: SIGUSD, amount: 100n, strike: 600_000n, premium: 2_000_000n };
  run(
    buildWrite({
      ...callTerms,
      writer: stranger.address,
      expiry: chain.height + 500,
      height: chain.height,
      inputs: stranger.utxos.toArray(),
    }),
    stranger,
  );
  run(
    buildWrite({
      ...callTerms,
      writer: stranger.address,
      expiry: chain.height + 400,
      height: chain.height,
      inputs: stranger.utxos.toArray(),
    }),
    stranger,
  );
  run(
    buildOptionBuy({
      height: chain.height,
      inputs: me.utxos.toArray(),
      buyer: me.address,
      optionBox: calls.utxos.at(1),
    }),
    me,
  );
  run(
    buildWrite({
      ...callTerms,
      writer: me.address,
      expiry: chain.height + 50,
      height: chain.height,
      inputs: me.utxos.toArray(),
    }),
    me,
  );
  run(
    buildWrite({
      side: "put",
      tokenId: SIGUSD,
      amount: 100n,
      strike: 400_000n,
      premium: 1_000_000n,
      writer: stranger.address,
      expiry: chain.height + 500,
      height: chain.height,
      inputs: stranger.utxos.toArray(),
    }),
    stranger,
  );

  const tokens: World["tokens"] = {};
  for (const t of tokenlist.tokens) tokens[t.id] = { name: t.name, decimals: t.decimals };
  tokens[P.tokens.stableCoinId] = { name: "SigUSD", decimals: 2 };
  tokens[P.tokens.reserveCoinId] = { name: "SigRSV", decimals: 0 };
  const world: World = {
    height: chain.height,
    boxes: parties.flatMap((p) => p.utxos.toArray()),
    tokens,
    submitted: [],
  };
  return { chain, me, stranger, other, world, bonds, escrows, programs, programsSell, calls, puts };
}
