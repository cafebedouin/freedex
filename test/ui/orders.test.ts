// @vitest-environment happy-dom
// The Limit orders tab: Machina orders and Babel boxes grouped by token, best price first on each side.
import { beforeEach, describe, expect, it } from "vitest";
import { groupListings, type Listing } from "../../src/ui/orders";
import { makeWorld } from "./fixtures";
import { column, connect, el, installFetch, installWallet, loadPage, noWallet, settle } from "./harness";

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
});
