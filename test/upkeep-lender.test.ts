// The lender-collateral finder: matured bonds whose lender is the visitor, with collateral worth more than the fee.
import { MockChain } from "@fleet-sdk/mock-chain";
import { describe, expect, it } from "vitest";
import {
  bondContract,
  buildLend,
  buildLiquidate,
  buildOpenOrder,
  orderContract,
  SIGMAFI_TEMPLATES,
} from "../src/bonds";
import type { Explorer } from "../src/explorer";
import { maturedBondsFor } from "../src/upkeep";

const ERG = 1_000_000_000n;

describe("maturedBondsFor", () => {
  it("picks the matured bond lent by the visitor and leaves the others", async () => {
    const chain = new MockChain({ height: 1_900_000 });
    const borrower = chain.newParty("borrower"),
      me = chain.newParty("me"),
      other = chain.newParty("other");
    const orders = chain.addParty(orderContract("ERG"), "orders"),
      bonds = chain.addParty(bondContract("ERG"), "bonds");
    borrower.addBalance({ nanoergs: 50n * ERG });
    me.addBalance({ nanoergs: 50n * ERG });
    other.addBalance({ nanoergs: 50n * ERG });
    const open = (term: number) => {
      expect(
        chain.execute(
          buildOpenOrder({
            height: chain.height,
            inputs: borrower.utxos.toArray(),
            borrower: borrower.address,
            principalId: "ERG",
            principal: 1n * ERG,
            repayment: 1_100_000_000n,
            term,
            collateralErg: 2n * ERG,
          }),
          { signers: [borrower] },
        ),
      ).toBe(true);
      return orders.utxos.at(orders.utxos.length - 1);
    };
    const lend = (lender: typeof me, orderBox: ReturnType<typeof open>) =>
      expect(
        chain.execute(
          buildLend({ height: chain.height, inputs: lender.utxos.toArray(), lender: lender.address, orderBox }),
          { signers: [lender] },
        ),
      ).toBe(true);
    lend(me, open(100)); // matures soon, mine
    lend(other, open(100)); // matures soon, someone else's
    lend(me, open(10_000)); // mine, not matured
    chain.jumpTo(chain.height + 101);
    const all = bonds.utxos.toArray();
    expect(all.length).toBe(3);
    const explorer = {
      byTemplate: async (hash: string) => (hash === SIGMAFI_TEMPLATES.bondErg ? all : []),
    } as unknown as Explorer;
    const due = await maturedBondsFor(explorer, chain.height, [me.address.encode()]);
    expect(due.length).toBe(1);
    expect(due[0].v.lender).toBe(me.address.encode());
    expect(due[0].v.maturity).toBeLessThanOrEqual(chain.height);
    expect(due[0].v.collateralErg).toBe(2n * ERG);
    // before maturity nothing; with no addresses nothing and no explorer call
    expect(await maturedBondsFor(explorer, chain.height - 101, [me.address.encode()])).toEqual([]);
    let called = 0;
    const counting = { byTemplate: async () => (called++, []) } as unknown as Explorer;
    expect(await maturedBondsFor(counting, chain.height, [])).toEqual([]);
    expect(called).toBe(0);
  });

  it("the hand-over itself is keyless: a stranger's boxes pay the fee and nobody but the stranger signs", () => {
    const chain = new MockChain({ height: 1_900_000 });
    const borrower = chain.newParty("borrower"),
      lender = chain.newParty("lender"),
      stranger = chain.newParty("stranger");
    const orders = chain.addParty(orderContract("ERG"), "orders"),
      bonds = chain.addParty(bondContract("ERG"), "bonds");
    borrower.addBalance({ nanoergs: 10n * ERG });
    lender.addBalance({ nanoergs: 10n * ERG });
    stranger.addBalance({ nanoergs: 1n * ERG });
    expect(
      chain.execute(
        buildOpenOrder({
          height: chain.height,
          inputs: borrower.utxos.toArray(),
          borrower: borrower.address,
          principalId: "ERG",
          principal: 2n * ERG,
          repayment: 2_100_000_000n,
          term: 100,
          collateralErg: 5n * ERG,
        }),
        { signers: [borrower] },
      ),
    ).toBe(true);
    expect(
      chain.execute(
        buildLend({
          height: chain.height,
          inputs: lender.utxos.toArray(),
          lender: lender.address,
          orderBox: orders.utxos.at(0),
        }),
        { signers: [lender] },
      ),
    ).toBe(true);
    const lenderBefore = lender.balance.nanoergs,
      strangerBefore = stranger.balance.nanoergs;
    chain.jumpTo(chain.height + 101);
    const liq = buildLiquidate({
      height: chain.height,
      inputs: stranger.utxos.toArray(),
      recipient: stranger.address,
      bondBox: bonds.utxos.at(0),
    });
    expect(chain.execute(liq, { signers: [stranger] })).toBe(true);
    expect(lender.balance.nanoergs - lenderBefore).toBe(5n * ERG); // the whole collateral
    expect(strangerBefore - stranger.balance.nanoergs).toBe(1_000_000n); // the miner fee, from the stranger's change
    expect(bonds.utxos.length).toBe(0);
  });
});
