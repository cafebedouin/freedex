// @vitest-environment happy-dom
// The header says when the page is reading from the second explorer because the first did not answer.
import { describe, expect, it } from "vitest";
import { makeWorld } from "./fixtures";
import { installFetch, loadPage, noWallet, text } from "./harness";

describe("explorer status", () => {
  it("is empty while the first backend answers", async () => {
    const w = makeWorld();
    installFetch(w.world);
    noWallet();
    await loadPage();
    expect(text("explorer-status")).toBe("");
    expect(text("log")).toContain("explorer https://api.ergoplatform.com, height");
  });

  it("names the fallback and the backend that failed", async () => {
    const w = makeWorld();
    w.world.failFirstBase = true;
    installFetch(w.world);
    noWallet();
    await loadPage();
    expect(text("explorer-status")).toBe("reading from api.ergo.aap.cornell.edu: api.ergoplatform.com did not answer");
    expect(text("swap-route")).toBe("ERG pool, 1000 ERG deep"); // the page still works
  });
});
