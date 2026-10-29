// @vitest-environment happy-dom
// The Pool tab: a deposit typed from either side fills the other at the pool's ratio, on ERG pairs and token pairs.
import { beforeEach, describe, expect, it } from "vitest";
import { makeWorld, NFT2, SIGUSD } from "./fixtures";
import { choose, el, installFetch, loadPage, noWallet, rows, settle, tab, type } from "./harness";

describe("Pool tab", () => {
  beforeEach(async () => {
    const w = makeWorld();
    installFetch(w.world);
    noWallet();
    await loadPage();
    tab("pool");
    await settle();
  });

  it("ERG pair: typing ERG fills the tokens, typing tokens fills the ERG", async () => {
    choose("lp-token", `n2t:${SIGUSD}`);
    await settle();
    expect(rows("lp-info")["Reserves"]).toBe("1000 ERG and 20000 SigUSD");
    type("lp-erg", "1");
    expect(el<HTMLInputElement>("lp-tok").value).toBe("20");
    expect(rows("lp-quote")["LP tokens you receive"]).toBe("1000");
    type("lp-tok", "40");
    expect(el<HTMLInputElement>("lp-erg").value).toBe("2");
    expect(rows("lp-quote")["LP tokens you receive"]).toBe("2000");
    expect(el<HTMLButtonElement>("lp-add").disabled).toBe(true); // no wallet
  });

  it("token pair: either side typed, the other at the pool's ratio", async () => {
    choose("lp-token", `t2t:${NFT2}`);
    await settle();
    expect(el("lp-erg-name").textContent).toBe("SigUSD");
    expect(el("lp-tok-name").textContent).toBe("rsBTC");
    type("lp-erg", "1");
    expect(el<HTMLInputElement>("lp-tok").value).toBe("0.0001");
    type("lp-tok", "0.5");
    expect(el<HTMLInputElement>("lp-erg").value).toBe("5000");
  });

  it("a redemption quote names both sides", async () => {
    choose("lp-token", `n2t:${SIGUSD}`);
    await settle();
    type("lp-in", "1000");
    expect(rows("lp-redeem-quote")["You receive"]).toBe("1 ERG and 20 SigUSD");
  });
});
