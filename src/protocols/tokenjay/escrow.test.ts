// TokenJay's deployed escrow script on the mock chain: create, the named buyer takes, the seller cancels, a stranger cannot.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import {
  ESCROW_TREE,
  buildCancelEscrow,
  buildCreateEscrow,
  buildTakeEscrow,
  describeEscrow,
  escrowFee,
} from "./escrow";

const TOKEN = "55".repeat(32);
const ERG = 1_000_000_000n;

describe("escrow", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const seller = chain.newParty("seller");
  const buyer = chain.newParty("buyer");
  const stranger = chain.newParty("stranger");
  const escrow = chain.addParty(ESCROW_TREE, "escrow");
  afterEach(() => chain.reset({ clearParties: true }));

  function create() {
    seller.addBalance({ nanoergs: 1n * ERG, tokens: [{ tokenId: TOKEN, amount: 100n }] });
    buyer.addBalance({ nanoergs: 5n * ERG });
    stranger.addBalance({ nanoergs: 5n * ERG });
    chain.addParty(seller);
    chain.addParty(buyer);
    chain.addParty(stranger);
    chain.addParty(escrow);
    const tx = buildCreateEscrow({
      height: chain.height,
      inputs: seller.utxos.toArray(),
      seller: seller.address,
      buyer: buyer.address,
      tokenId: TOKEN,
      amount: 100n,
      price: 2n * ERG,
    });
    expect(chain.execute(tx, { signers: [seller] })).toBe(true);
    const e = describeEscrow(escrow.utxos.at(0));
    expect(e.seller).toBe(seller.address.encode());
    expect(e.buyer).toBe(buyer.address.encode());
    expect(e.price).toBe(2n * ERG);
    expect(e.feeRate).toBe(0n);
    return e;
  }

  it("the named buyer takes it; the contract's fee returns to the seller", () => {
    const e = create();
    const fee = escrowFee(e.price, e.feeRate);
    expect(fee).toBe(1_000_000n);
    const sellerBefore = seller.balance.nanoergs;
    const tx = buildTakeEscrow({
      height: chain.height,
      inputs: buyer.utxos.toArray(),
      buyer: buyer.address,
      escrowBox: escrow.utxos.at(0),
    });
    expect(chain.execute(tx, { signers: [buyer] })).toBe(true);
    expect(buyer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 100n }]);
    // the escrow box's own value becomes the buyer's token box and covers the miner fee: the buyer pays the price exactly
    expect(buyer.balance.nanoergs).toBe(5n * ERG - 2n * ERG);
    expect(seller.balance.nanoergs - sellerBefore).toBe(2n * ERG); // the price in full: the pay box plus the fee box, both to the seller
    expect(escrow.utxos.length).toBe(0);
  });

  it("a stranger cannot take it", () => {
    create();
    expect(() =>
      buildTakeEscrow({
        height: chain.height,
        inputs: stranger.utxos.toArray(),
        buyer: stranger.address,
        escrowBox: escrow.utxos.at(0),
      }),
    ).toThrow(/named buyer/);
    // and forcing it past the builder: the script refuses the token output to the stranger
    const tx = buildTakeEscrow({
      height: chain.height,
      inputs: stranger.utxos.toArray(),
      buyer: buyer.address,
      escrowBox: escrow.utxos.at(0),
    });
    tx.outputs[1].ergoTree = stranger.address.ergoTree;
    expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
  });

  it("the seller cancels with one of their own boxes as the second input", () => {
    create();
    const tx = buildCancelEscrow({
      height: chain.height,
      inputs: seller.utxos.toArray(),
      seller: seller.address,
      escrowBox: escrow.utxos.at(0),
    });
    expect(tx.inputs[0].boxId).toBe(escrow.utxos.at(0).boxId);
    expect(tx.inputs[1].ergoTree).toBe(seller.address.ergoTree);
    expect(chain.execute(tx, { signers: [seller] })).toBe(true);
    expect(seller.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 100n }]);
    expect(escrow.utxos.length).toBe(0);
  });
});
