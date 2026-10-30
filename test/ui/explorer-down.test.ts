// @vitest-environment happy-dom
// When the explorer answers nothing, every tab says so instead of showing an empty table, the header line shows the
// retrying state, and a retry button reloads once the explorer is back. The harness zeroes the retry waits.
import { beforeEach, describe, expect, it } from "vitest";
import { makeWorld } from "./fixtures";
import { el, installFetch, loadPage, noWallet, settle, tab, text } from "./harness";

describe("the explorer down", () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(async () => {
    w = makeWorld();
    w.world.failAll = true;
    installFetch(w.world);
    noWallet();
    await loadPage();
    await settle(200);
  });

  it("says 'explorer unavailable' in the header and on every listing, with a retry button", async () => {
    expect(text("explorer-status")).toMatch(/^explorer unavailable \(fetch failed\); retrying at the next refresh$/);
    expect(text("swap-route")).toContain("explorer unavailable");
    expect(text("orders")).toMatch(/^explorer unavailable \(fetch failed\) retry$/);
    for (const [name, id] of [
      ["bonds", "orders-list"],
      ["escrow", "escrow-list"],
      ["programs", "programs-list"],
      ["options", "options-list"],
    ] as const) {
      tab(name);
      await settle(100);
      expect(text(id), name).toMatch(/^explorer unavailable \(fetch failed\) retry$/);
    }
    tab("pool");
    await settle(50);
    expect(text("lp-info")).toContain("explorer unavailable");
    tab("bank");
    await settle(100);
    expect(text("bank-info")).toContain("explorer unavailable");
    expect(text("log")).toContain("could not load pools: fetch failed");
  });

  it("the retry button loads the listing once the explorer answers again", async () => {
    tab("escrow");
    await settle(100);
    expect(text("escrow-list")).toContain("retry");
    w.world.failAll = false;
    el("escrow-list").querySelector("button")!.click();
    await settle(100);
    expect(text("escrow-list")).not.toContain("explorer unavailable");
    expect(el("escrow-list").querySelector("table")).not.toBeNull();
  });

  it("reports the try in progress while a request is being retried", async () => {
    // the explorer reports each failed try before sleeping; the header shows the last one until an answer comes
    const seen: string[] = [];
    const status = el("explorer-status");
    const mo = new MutationObserver(() => seen.push(status.textContent ?? ""));
    mo.observe(status, { childList: true, characterData: true, subtree: true });
    tab("escrow");
    await settle(100);
    mo.disconnect();
    expect(
      seen.some((s) => /explorer unavailable \(api\.ergoplatform\.com, try [123] failed\), retrying…/.test(s)),
    ).toBe(true);
  });
});
