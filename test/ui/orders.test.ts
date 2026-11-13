// @vitest-environment happy-dom
// The Limit orders tab: Machina orders and Babel boxes grouped by token, best price first on each side.
import { beforeEach, describe, expect, it } from "vitest";
import { ErgoBox } from "@fleet-sdk/core";
import { buildCreate } from "../../src/protocols/machina/orders";
import { V2_NOTE, groupListings, type Listing } from "../../src/ui/orders";
import { RSBTC, makeWorld } from "./fixtures";
import { column, connect, el, installFetch, installWallet, loadPage, noWallet, settle, text } from "./harness";

describe("groupListings", () => {
  const l = (tokenId: string, takerAction: "buy" | "sell", price: bigint): Listing =>
    ({ kind: "machina", tokenId, takerAction, price, capacity: 1n, value: 1n, owner: "o" }) as Listing;
  it("groups by token, most listings first; buys cheapest first, sells dearest first", () => {
    const g = groupListings([
      l("b", "buy", 5n),
      l("a", "sell", 1n),
      l("a", "buy", 3n),
      l("a", "sell", 2n),
      l("a", "buy", 2n),
    ]);
    expect(g.map((x) => x.tokenId)).toEqual(["a", "b"]);
    expect(g[0].buys.map((x) => x.price)).toEqual([2n, 3n]);
    expect(g[0].sells.map((x) => x.price)).toEqual([2n, 1n]);
  });
});

describe("Limit orders tab", () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(async () => {
    w = makeWorld();
    installFetch(w.world);
    noWallet();
    await loadPage();
  });

  it("lists the SigUSD group first with Babel bids among the orders takers sell into", () => {
    const groups = el("orders").querySelectorAll("details");
    expect(groups.length).toBe(2);
    expect(groups[0].querySelector("summary")?.textContent).toBe(
      "SigUSD 4 orders; best: buy from 0.4, sell at 0.35 ERG/token",
    );
    expect(groups[1].querySelector("summary")?.textContent).toBe("rsBTC 1 order; best: buy from 100 ERG/token");
    const [buys, sells] = groups[0].querySelectorAll("table");
    expect(column(buys, 0)).toEqual(["0.4", "0.5"]);
    expect(column(buys, 1)).toEqual(["5", "10"]);
    expect(column(sells, 0)).toEqual(["0.35", "0.3"]);
    expect(column(sells, 1)).toEqual(["2.85 (1 ERG)", "3.33 (1 ERG)"]);
    expect(column(sells, 2)[0]).toMatch(/… Babel$/);
    expect(column(sells, 2)[1]).not.toContain("Babel");
    expect(el("orders").querySelectorAll("button").length).toBe(0); // no wallet, no actions
  });

  it("with a wallet: the visitor's group opens, their order can be closed, the others filled", async () => {
    installWallet(w.chain, w.me);
    await loadPage();
    await connect();
    await settle();
    const groups = el("orders").querySelectorAll("details");
    expect(groups[1].open).toBe(true);
    expect(column(groups[1].querySelector("table")!, 2)).toEqual([`${w.me.address.encode().slice(0, 6)}… (you)`]);
    expect([...groups[1].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["close"]);
    expect([...groups[0].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["buy", "buy", "sell", "sell"]);
    expect(groups[0].querySelectorAll("input").length).toBe(4);
  });

  it("marks a version-2 order v2, and says before the prompt that filling it needs a library that reads version 2", async () => {
    // the stranger offers 1 rsBTC unit under Machina's version-2 tree
    const tx = buildCreate({
      height: w.chain.height,
      inputs: w.stranger.utxos.toArray(),
      owner: w.stranger.address,
      side: "buy-tokens",
      quoteTokenId: RSBTC,
      price: 2_000n,
      ergAmount: 10_000_000n,
      treeVersion: 2,
    });
    const o = tx.outputs[0];
    const e = new ErgoBox(
      {
        value: BigInt(o.value),
        ergoTree: o.ergoTree,
        creationHeight: o.creationHeight,
        assets: o.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
        additionalRegisters: o.additionalRegisters,
      },
      "11".repeat(32),
      0,
    );
    w.world.boxes.push({
      boxId: e.boxId,
      transactionId: e.transactionId,
      index: e.index,
      value: e.value,
      ergoTree: e.ergoTree,
      creationHeight: e.creationHeight,
      assets: e.assets,
      additionalRegisters: e.additionalRegisters,
    });
    w.me.addBalance({ nanoergs: 0n, tokens: [{ tokenId: RSBTC, amount: 10n }] });
    const wallet = installWallet(w.chain, w.me);
    await loadPage();
    el<HTMLInputElement>("upkeep-on").checked = false;
    await connect();
    await settle();
    expect(text("orders-v2-note")).toMatch(
      /^Experimental: orders marked "v2" use Machina's ErgoTree version 2 contract/,
    );
    expect(text("orders-v2-note")).toContain("New orders placed here are still created as version 1");
    const rsbtc = [...el("orders").querySelectorAll("details")].find((d) => d.textContent?.startsWith("rsBTC"))!;
    const sells = [...rsbtc.querySelectorAll("table")].at(-1)!;
    expect(column(sells, 2)[0]).toMatch(/… v2$/);
    const row = sells.querySelector("tbody tr")!;
    row.querySelector("input")!.value = "0.00000001";
    row.querySelector("button")!.click();
    await settle(100);
    expect(wallet.sign_tx).toHaveBeenCalledTimes(1);
    expect(text("log")).toContain(V2_NOTE);
  });
});
