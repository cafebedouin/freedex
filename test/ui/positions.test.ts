// @vitest-environment happy-dom
// Bonds and Escrow tabs: the visitor's own rows first, before the market.
import { beforeEach, describe, expect, it } from "vitest";
import { describeBond } from "../../src/protocols/sigmafi/bonds";
import { makeWorld } from "./fixtures";
import { column, connect, el, installFetch, installWallet, loadPage, noWallet, settle, tab, text } from "./harness";

const before = (a: string, b: string) => !!(el(a).compareDocumentPosition(el(b)) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("positions", () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    w = makeWorld();
    installFetch(w.world);
  });

  it("Bonds: without a wallet the market shows every request", async () => {
    noWallet();
    await loadPage();
    tab("bonds");
    await settle();
    expect(text("bonds-mine")).toBe("connect a wallet to see your loan requests and bonds");
    expect(column(el("orders-list").querySelector("table")!, 0)).toEqual(["3 ERG", "1 ERG"]);
    // the bond the visitor lent on is market to a visitor without a wallet
    expect(column(el("bonds-list").querySelector("table")!, 1)).toEqual([
      `${describeBond(w.bonds.utxos.at(0)).maturity} (matured)`,
    ]);
  });

  it("Bonds: with a wallet the visitor's request and bond come first, the market without them", async () => {
    installWallet(w.chain, w.me);
    await loadPage();
    await connect();
    tab("bonds");
    await settle();
    expect(before("open-order", "bonds-mine")).toBe(true); // the request form first, then the positions
    expect(before("bonds-mine", "orders-list")).toBe(true);
    // the market lists are collapsed, their counts on the summary line
    expect(el<HTMLDetailsElement>("orders-details").open).toBe(false);
    expect(el<HTMLDetailsElement>("bonds-details").open).toBe(false);
    expect(text("orders-count")).toBe("1 open");
    expect(text("bonds-count")).toBe("0 live");
    const mine = el("bonds-mine");
    expect([...mine.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Your loan requests",
      "Your bonds (borrowed or lent)",
    ]);
    const [requests, bonds] = mine.querySelectorAll("table");
    expect(column(requests, 0)).toEqual(["1 ERG"]);
    expect(column(requests, 4)[0]).toContain("(you)");
    expect(column(bonds, 1)).toEqual([`${describeBond(w.bonds.utxos.at(0)).maturity} (matured)`]);
    expect(text("bonds-list")).toBe("no bonds");
    expect(column(bonds, 4)[0]).toContain("(you)");
    expect([...mine.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["cancel", "take collateral"]);
    expect(column(el("orders-list").querySelector("table")!, 0)).toEqual(["3 ERG"]);
    expect(text("orders-list")).not.toContain("(you)");
  });

  it("Escrow: the visitor's escrow first with its action, then the other open escrow", async () => {
    installWallet(w.chain, w.me);
    await loadPage();
    await connect();
    tab("escrow");
    await settle();
    expect(before("escrow-mine", "escrow-list")).toBe(true);
    const mine = el("escrow-mine").querySelector("table")!;
    expect(column(mine, 0)).toEqual(["0.1 SigUSD"]);
    expect(column(mine, 3)[0]).toContain("(you)");
    expect([...mine.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["pay and take"]);
    const market = el("escrow-list").querySelector("table")!;
    expect(column(market, 0)).toEqual(["0.2 SigUSD"]);
    expect(market.querySelectorAll("button").length).toBe(0);
  });

  it("Escrow: without a wallet the market still lists every open escrow", async () => {
    noWallet();
    await loadPage();
    tab("escrow");
    await settle();
    expect(text("escrow-mine")).toBe("connect a wallet to see your escrows");
    expect(column(el("escrow-list").querySelector("table")!, 1)).toEqual(["0.002 ERG", "0.004 ERG"]);
  });
});
