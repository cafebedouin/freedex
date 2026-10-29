// @vitest-environment happy-dom
// The Bank tab: the quote's "Allowed by the bank" line follows the reserve-ratio band.
import { beforeEach, describe, expect, it } from "vitest";
import { makeWorld } from "./fixtures";
import { choose, el, installFetch, loadPage, noWallet, rows, settle, tab, type } from "./harness";

describe("Bank tab", () => {
  beforeEach(async () => {
    const w = makeWorld();
    installFetch(w.world);
    noWallet();
    await loadPage();
    tab("bank");
    await settle();
  });

  it("shows the bank and says yes to a small SigUSD mint", () => {
    const info = rows("bank-info");
    expect(info["Oracle"]).toBe("3 ERG per USD");
    expect(info["Reserve ratio"]).toBe("666%");
    type("bank-amount", "10");
    const q = rows("bank-quote");
    expect(q["Allowed by the bank"]).toBe("yes");
    expect(q["You pay (all fees in)"]).toBe("30.601 ERG"); // 10 USD at 3 ERG plus 2% plus the miner fee
    expect(el<HTMLButtonElement>("bank-go").textContent).toBe("Connect a wallet");
  });

  it("says no when the mint would take the ratio under 400%", () => {
    type("bank-amount", "100000");
    const q = rows("bank-quote");
    expect(q["Allowed by the bank"]).toBe("no (the ratio would leave the band)");
    expect(Number(q["Reserve ratio after"].replace("%", ""))).toBeLessThan(400);
  });

  it("redeeming SigRSV is quoted in its own unit", () => {
    choose("bank-action", "redeem:reserve");
    expect(el("bank-amount-name").textContent).toBe("SigRSV");
    type("bank-amount", "1000");
    expect(rows("bank-quote")["Allowed by the bank"]).toBe("yes");
  });
});
