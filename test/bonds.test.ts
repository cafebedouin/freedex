// SigmaFi's deployed order and bond scripts on the mock chain: open, cancel, lend, repay, liquidate after maturity.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { bondContract, buildCancelOrder, buildLend, buildLiquidate, buildOpenOrder, buildRepay, describeBond, describeOrder, devFee, orderContract, uiFee } from "../src/bonds";
import { FEE } from "../src/orders";

const ERG = 1_000_000_000n;
const TOKEN = "66".repeat(32);

describe("SigmaFi bonds, ERG principal", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const borrower = chain.newParty("borrower");
  const lender = chain.newParty("lender");
  const orders = chain.addParty(orderContract("ERG"), "orders");
  const bonds = chain.addParty(bondContract("ERG"), "bonds");
  afterEach(() => chain.reset({ clearParties: true }));

  function open() {
    borrower.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: TOKEN, amount: 1_000n }] });
    lender.addBalance({ nanoergs: 10n * ERG });
    chain.addParty(borrower); chain.addParty(lender); chain.addParty(orders); chain.addParty(bonds);
    const tx = buildOpenOrder({ height: chain.height, inputs: borrower.utxos.toArray(), borrower: borrower.address, principalId: "ERG", principal: 2n * ERG, repayment: 2_100_000_000n, term: 1_000, collateralErg: 5n * ERG, collateralTokens: [{ tokenId: TOKEN, amount: 1_000n }] });
    expect(chain.execute(tx, { signers: [borrower] })).toBe(true);
    const o = describeOrder(orders.utxos.at(0));
    expect(o.principal).toBe(2n * ERG);
    expect(o.repayment).toBe(2_100_000_000n);
    expect(o.term).toBe(1_000);
    expect(o.borrower).toBe(borrower.address.encode());
    expect(o.collateralErg).toBe(5n * ERG);
    return o;
  }

  it("borrower cancels", () => {
    open();
    const tx = buildCancelOrder({ height: chain.height, inputs: borrower.utxos.toArray(), borrower: borrower.address, orderBox: orders.utxos.at(0) });
    expect(chain.execute(tx, { signers: [borrower] })).toBe(true);
    expect(orders.utxos.length).toBe(0);
    expect(borrower.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 1_000n }]);
  });

  it("lender closes, borrower repays before maturity", () => {
    open();
    const lenderBefore = lender.balance.nanoergs, borrowerBefore = borrower.balance.nanoergs;
    const lendHeight = chain.height;
    const lend = buildLend({ height: lendHeight, inputs: lender.utxos.toArray(), lender: lender.address, orderBox: orders.utxos.at(0) });
    expect(chain.execute(lend, { signers: [lender] })).toBe(true);
    expect(orders.utxos.length).toBe(0);
    const b = describeBond(bonds.utxos.at(0));
    expect(b.lender).toBe(lender.address.encode());
    expect(b.borrower).toBe(borrower.address.encode());
    expect(b.maturity).toBe(lendHeight + 1_000);
    expect(borrower.balance.nanoergs - borrowerBefore).toBe(2n * ERG);
    // the lender paid the principal, the developer fee and the miner fee; the "UI fee" came back to them
    expect(lenderBefore - lender.balance.nanoergs).toBe(2n * ERG + devFee(2n * ERG) + FEE);
    expect(uiFee(2n * ERG)).toBe(8_000_000n);

    const repay = buildRepay({ height: chain.height, inputs: borrower.utxos.toArray(), borrower: borrower.address, bondBox: bonds.utxos.at(0) });
    expect(chain.execute(repay, { signers: [borrower] })).toBe(true);
    expect(bonds.utxos.length).toBe(0);
    expect(borrower.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 1_000n }]);
    expect(lender.balance.nanoergs - lenderBefore).toBe(2_100_000_000n - 2n * ERG - devFee(2n * ERG) - FEE);
  });

  it("after maturity anyone may hand the collateral to the lender; before, nobody can", () => {
    open();
    const lend = buildLend({ height: chain.height, inputs: lender.utxos.toArray(), lender: lender.address, orderBox: orders.utxos.at(0) });
    expect(chain.execute(lend, { signers: [lender] })).toBe(true);
    const bond = bonds.utxos.at(0);
    expect(() => buildLiquidate({ height: chain.height, inputs: lender.utxos.toArray(), recipient: lender.address, bondBox: bond })).toThrow(/matures/);
    chain.jumpTo(chain.height + 1_001);
    const liq = buildLiquidate({ height: chain.height, inputs: lender.utxos.toArray(), recipient: lender.address, bondBox: bond });
    expect(chain.execute(liq, { signers: [lender] })).toBe(true);
    expect(bonds.utxos.length).toBe(0);
    expect(lender.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 1_000n }]);
  });
});
