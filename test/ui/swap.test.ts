// @vitest-environment happy-dom
// The Swap tab: route resolution, the quote rows with the bank beside the pool, and the stale-quote refusal.
import { beforeEach, describe, expect, it } from "vitest";
import { makeWorld, RSBTC, RSFIRO, RSN, SIGUSD } from "./fixtures";
import {
  choose,
  connect,
  el,
  installFetch,
  installWallet,
  loadPage,
  noWallet,
  rows,
  settle,
  text,
  type,
} from "./harness";

describe("Swap tab", () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(async () => {
    w = makeWorld();
    installFetch(w.world);
    noWallet();
    await loadPage();
  });

  it("routes ERG to SigUSD through the ERG pool and quotes from the pool's rule", () => {
    expect(el<HTMLSelectElement>("swap-from").value).toBe("ERG");
    expect(el<HTMLSelectElement>("swap-to").value).toBe(SIGUSD);
    expect(text("swap-route")).toBe("ERG pool, 1000 ERG deep");
    type("swap-in", "1");
    const r = rows("swap-quote");
    expect(r["Pool price"]).toBe("0.05 ERG per SigUSD");
    expect(r["Pool fee"]).toBe("0.3% to liquidity providers");
    expect(r["You receive (estimate)"]).toBe("19.92 SigUSD");
    expect(r["Minimum after slippage"]).toBe("19.73");
    expect(r["Miner fee"]).toBe("0.001 ERG (the only fee this page adds)");
    expect(el<HTMLInputElement>("swap-out").value).toBe("19.92");
    expect(el<HTMLButtonElement>("swap-go").disabled).toBe(true); // no wallet
    // the bank is quoted beside the pool for SigUSD, and only shown
    expect(r["Same tokens from the bank"]).toMatch(/^\d+(\.\d+)? ERG \(dearer\)$/);
  });

  it("says when no ERG pool holds the token", () => {
    choose("swap-to", RSFIRO);
    expect(text("swap-route")).toBe("no ErgoDEX ERG pool holds rsFIRO");
    expect(rows("swap-quote")).toEqual({});
  });

  it("routes two tokens through their direct pool when one exists", () => {
    choose("swap-from", RSBTC);
    choose("swap-to", SIGUSD);
    expect(text("swap-route")).toBe("direct rsBTC/SigUSD pool");
    type("swap-in", "0.1");
    const r = rows("swap-quote");
    expect(r["Pool reserves"]).toBe("10000 SigUSD and 1 rsBTC");
    // 0.1 rsBTC into 1 rsBTC / 10,000 SigUSD: 1e6 * 1e7 * 997 / (1e8 * 1000 + 1e7 * 997) = 90,661 units
    expect(r["You receive (estimate)"]).toBe("906.61 SigUSD");
  });

  it("refuses two tokens without a direct pool and names the way round", () => {
    choose("swap-from", RSBTC);
    choose("swap-to", RSN);
    expect(text("swap-route")).toBe("no direct rsBTC/RSN pool: swap to ERG first, then to RSN");
  });

  it("with a wallet, a changed amount that was never quoted is refused as stale", async () => {
    installWallet(w.chain, w.me);
    await loadPage();
    await connect();
    expect(text("wallet")).toContain("nautilus:");
    type("swap-in", "1");
    const go = el<HTMLButtonElement>("swap-go");
    expect(go.disabled).toBe(false);
    expect(go.textContent).toBe("Swap");
    el<HTMLInputElement>("swap-in").value = "2"; // no input event: the quote on screen is for 1
    go.click();
    await settle();
    expect(text("log")).toContain("swap failed: the quote is stale; type the amount again");
  });
});
