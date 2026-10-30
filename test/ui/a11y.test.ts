// @vitest-environment happy-dom
// axe-core over the rendered page on every tab, with and without a wallet, and with the QR panel open: no violation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { fakeErgoLib } from "../fake-ergolib";
import { makeWorld } from "./fixtures";
import { connect, el, installFetch, installWallet, loadPage, noWallet, settle, tab, type } from "./harness";

const TABS = ["swap", "orders", "pool", "bank", "bonds", "escrow", "programs", "options"] as const;

async function violations(): Promise<string[]> {
  const r = await axe.run(document, {
    // happy-dom lays nothing out, so the colour-contrast check cannot run; everything structural is on
    rules: { "color-contrast": { enabled: false } },
  });
  return r.violations.map((v) => `${v.id}: ${v.help} [${v.nodes.map((n) => n.target.join(" ")).join(", ")}]`);
}

describe("accessibility (axe-core)", () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    w = makeWorld();
    installFetch(w.world);
  });
  afterEach(() => vi.doUnmock("ergo-lib-wasm-browser"));

  // axe over a whole tab takes up to a second in happy-dom; eight tabs twice over is well past the default 5 s
  const SLOW = { timeout: 90_000 };

  it("every tab, no wallet", SLOW, async () => {
    noWallet();
    await loadPage();
    for (const t of TABS) {
      tab(t);
      await settle(100);
      expect(await violations(), t).toEqual([]);
    }
  });

  it("every tab with a wallet connected (rows with buttons and inputs), and the QR panel open", SLOW, async () => {
    installWallet(w.chain, w.me);
    await loadPage();
    el<HTMLInputElement>("upkeep-on").checked = false;
    await connect();
    for (const t of TABS) {
      tab(t);
      await settle(100);
      expect(await violations(), t).toEqual([]);
    }
    // the phone path: the QR panel open with a code, the link and the cancel button
    noWallet();
    const fake = fakeErgoLib("cd".repeat(32), new Uint8Array(900));
    vi.doMock("ergo-lib-wasm-browser", () => fake.lib);
    window.prompt = () => w.me.address.encode();
    await loadPage();
    el<HTMLInputElement>("upkeep-on").checked = false;
    [...el("wallet").querySelectorAll("button")]
      .find((b) => b.textContent?.startsWith("sign with your phone"))!
      .click();
    await settle(100);
    tab("swap");
    type("swap-in", "1");
    el<HTMLButtonElement>("swap-go").click();
    for (let i = 0; i < 40 && el("ergopay").hidden; i++) await settle(50);
    expect(el("ergopay").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("ergopay");
    expect(await violations(), "QR panel").toEqual([]);
    el<HTMLButtonElement>("ergopay-cancel").click(); // the wait ends at its next poll; the hide and the focus return are test/ui/phone.test.ts's
  });
});
