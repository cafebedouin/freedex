// The three builders against the real Machina E2T contract on Fleet's mock chain.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { ErgoAddress } from "@fleet-sdk/core";
import { LimitOrder } from "@nautls/machinafi-sdk";
import { buildClose, buildCreate, buildFill, capacity, describe as view, takerAction } from "../src/orders";

const TOKEN = "03faf2cb329f2e90d6d23b58d91bbb6c046aa143261cc21f52fbe2824bfcbf04"; // SigUSD id, any 64-hex works
const ERG = 1_000_000_000n;

// The contract party is keyed by the E2T tree for TOKEN; its utxos are the open orders.
function contractTree(owner: ErgoAddress): string {
  return LimitOrder.create({
    owner,
    type: "buy",
    price: 1n,
    assets: { base: { tokenId: "ERG", amount: 0n }, quote: { tokenId: TOKEN, amount: 1n } },
  }).ergoTree;
}

describe("dexpage builders on the Machina E2T limit-order contract", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const owner = chain.newParty("owner");
  const taker = chain.newParty("taker");
  const contract = chain.addParty(contractTree(owner.address), "E2T limit");

  afterEach(() => chain.reset({ clearParties: true }));

  it("owner sells tokens: create, partial fill, full fill", () => {
    owner.addBalance({ nanoergs: 2n * ERG, tokens: [{ tokenId: TOKEN, amount: 100n }] });
    taker.addBalance({ nanoergs: 5n * ERG });
    chain.addParty(owner); chain.addParty(taker); chain.addParty(contract);

    const create = buildCreate({
      height: chain.height, inputs: owner.utxos.toArray(), owner: owner.address,
      side: "sell-tokens", quoteTokenId: TOKEN, price: 5_000_000n, tokenAmount: 100n,
    });
    expect(chain.execute(create, { signers: [owner] })).toBe(true);
    expect(contract.utxos.length).toBe(1);
    const order = view(contract.utxos.at(0));
    expect(order.takerAction).toBe("buy");
    expect(order.tokenAmount).toBe(100n);
    expect(order.price).toBe(5_000_000n);
    expect(order.owner).toBe(owner.address.encode());
    expect(capacity(order)).toBe(100n);
    const initialValue = order.value; // the SDK sizes a token order at the minimum for its bytes

    const partial = buildFill({
      height: chain.height, inputs: taker.utxos.toArray(), taker: taker.address,
      orderBox: contract.utxos.at(0), tokenAmount: 40n,
    });
    expect(chain.execute(partial, { signers: [taker] })).toBe(true);
    expect(contract.utxos.length).toBe(1);
    const after = view(contract.utxos.at(0));
    expect(after.tokenAmount).toBe(60n);
    expect(after.value).toBe(initialValue + 40n * 5_000_000n);
    expect(taker.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 40n }]);

    const full = buildFill({
      height: chain.height, inputs: taker.utxos.toArray(), taker: taker.address,
      orderBox: contract.utxos.at(0), tokenAmount: 60n,
    });
    expect(chain.execute(full, { signers: [taker] })).toBe(true);
    expect(contract.utxos.length).toBe(0);
    expect(taker.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 100n }]);
    // the owner got the ERG: 100 tokens at 0.005 ERG, plus the min box value back
    expect(owner.balance.nanoergs).toBe(2n * ERG - 1_100_000n + 100n * 5_000_000n);
  });

  it("owner buys tokens: create, taker sells into it, owner closes the rest", () => {
    owner.addBalance({ nanoergs: 3n * ERG });
    taker.addBalance({ nanoergs: 1n * ERG, tokens: [{ tokenId: TOKEN, amount: 50n }] });
    chain.addParty(owner); chain.addParty(taker); chain.addParty(contract);

    const create = buildCreate({
      height: chain.height, inputs: owner.utxos.toArray(), owner: owner.address,
      side: "buy-tokens", quoteTokenId: TOKEN, price: 10_000_000n, ergAmount: 1n * ERG,
    });
    expect(chain.execute(create, { signers: [owner] })).toBe(true);
    const order = view(contract.utxos.at(0));
    expect(order.takerAction).toBe("sell");
    expect(order.value).toBe(1n * ERG);
    expect(capacity(order)).toBe(100n);

    const sell = buildFill({
      height: chain.height, inputs: taker.utxos.toArray(), taker: taker.address,
      orderBox: contract.utxos.at(0), tokenAmount: 30n,
    });
    expect(chain.execute(sell, { signers: [taker] })).toBe(true);
    expect(contract.utxos.length).toBe(1);
    expect(view(contract.utxos.at(0)).tokenAmount).toBe(30n);
    expect(view(contract.utxos.at(0)).value).toBe(1n * ERG - 30n * 10_000_000n);
    expect(taker.balance.nanoergs).toBe(1n * ERG - 1_100_000n + 30n * 10_000_000n);

    const close = buildClose({
      height: chain.height, inputs: owner.utxos.toArray(), owner: owner.address,
      orderBox: contract.utxos.at(0),
    });
    expect(chain.execute(close, { signers: [owner] })).toBe(true);
    expect(contract.utxos.length).toBe(0);
    expect(owner.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 30n }]);
  });

  it("a taker cannot close someone else's order", () => {
    owner.addBalance({ nanoergs: 2n * ERG, tokens: [{ tokenId: TOKEN, amount: 10n }] });
    taker.addBalance({ nanoergs: 1n * ERG });
    chain.addParty(owner); chain.addParty(taker); chain.addParty(contract);
    const create = buildCreate({
      height: chain.height, inputs: owner.utxos.toArray(), owner: owner.address,
      side: "sell-tokens", quoteTokenId: TOKEN, price: 1_000_000n, tokenAmount: 10n,
    });
    expect(chain.execute(create, { signers: [owner] })).toBe(true);
    const steal = buildClose({
      height: chain.height, inputs: taker.utxos.toArray(), owner: taker.address,
      orderBox: contract.utxos.at(0),
    });
    expect(chain.execute(steal, { signers: [taker], throw: false })).toBe(false);
    expect(contract.utxos.length).toBe(1);
  });

  it("an underpaying fill is refused by the contract", () => {
    owner.addBalance({ nanoergs: 2n * ERG, tokens: [{ tokenId: TOKEN, amount: 10n }] });
    taker.addBalance({ nanoergs: 1n * ERG });
    chain.addParty(owner); chain.addParty(taker); chain.addParty(contract);
    const create = buildCreate({
      height: chain.height, inputs: owner.utxos.toArray(), owner: owner.address,
      side: "sell-tokens", quoteTokenId: TOKEN, price: 1_000_000n, tokenAmount: 10n,
    });
    expect(chain.execute(create, { signers: [owner] })).toBe(true);
    const fill = buildFill({
      height: chain.height, inputs: taker.utxos.toArray(), taker: taker.address,
      orderBox: contract.utxos.at(0), tokenAmount: 4n,
    });
    // pay for 3 tokens, take 4: lower the recreated order's value by one token's price
    const idx = fill.inputs.findIndex((i) => i.boxId === contract.utxos.at(0).boxId);
    expect(idx).toBeGreaterThanOrEqual(0);
    const out = fill.outputs.find((o) => o.ergoTree === contract.utxos.at(0).ergoTree)!;
    const cheated = { ...fill, outputs: fill.outputs.map((o) => (o === out ? { ...o, value: (BigInt(o.value) - 1_000_000n).toString() } : o)) };
    // keep the transaction balanced: hand the shaved nanoergs to the taker's change output
    const change = cheated.outputs.find((o) => o.ergoTree === taker.address.ergoTree)!;
    change.value = (BigInt(change.value) + 1_000_000n).toString();
    expect(chain.execute(cheated, { signers: [taker], throw: false })).toBe(false);
    expect(view(contract.utxos.at(0)).tokenAmount).toBe(10n);
    expect(takerAction(contract.utxos.at(0))).toBe("buy");
  });
});
