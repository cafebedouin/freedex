// @vitest-environment happy-dom
// Signing with the phone: the header asks for the address once and keeps it; a tab's send() reduces the transaction
// (the binding stubbed), shows the code and the link, and resolves when the explorer lists the id; the size guard;
// cancel; the upkeep's one signed job through the same path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeErgoLib } from "../fake-ergolib";
import { makeWorld } from "./fixtures";
import { el, installFetch, loadPage, noWallet, settle, text, type } from "./harness";

const TXID = "cd".repeat(32);
const LIB = "ergo-lib-wasm-browser";
const ERGOPAY = "../../src/ergopay";

describe("signing with the phone", () => {
  let w: ReturnType<typeof makeWorld>;
  let fake: ReturnType<typeof fakeErgoLib>;
  let reducedBytes = 900;

  beforeEach(async () => {
    w = makeWorld();
    installFetch(w.world);
    noWallet();
    fake = fakeErgoLib(TXID, new Uint8Array(reducedBytes));
    vi.doMock(LIB, () => fake.lib);
    vi.doMock(ERGOPAY, async (orig) => ({ ...(await orig<typeof import("../../src/ergopay")>()), POLL_MS: 20 }));
    window.prompt = () => w.me.address.encode();
    await loadPage();
  });
  afterEach(() => {
    vi.doUnmock(LIB);
    vi.doUnmock(ERGOPAY);
    reducedBytes = 900;
  });

  const walletButton = (prefix: string) =>
    [...el("wallet").querySelectorAll("button")].find((b) => b.textContent?.startsWith(prefix))!;
  const choosePhone = async (upkeep = false) => {
    el<HTMLInputElement>("upkeep-on").checked = upkeep;
    walletButton("sign with your phone").click();
    await settle(100);
  };

  it("asks for the address once, keeps it in this browser, and reads balances from the explorer", async () => {
    expect(text("wallet")).toContain("no EIP-12 wallet found (install Nautilus, or sign with your phone)");
    await choosePhone();
    expect(text("wallet")).toMatch(/^phone: 9\w{7}…\w{6} disconnect$/);
    expect(localStorage.getItem("freedex.phone")).toBe(w.me.address.encode());
    expect(text("log")).toContain(`signing with your phone as ${w.me.address.encode()}`);
    expect(text("swap-balance")).toMatch(/^balance 93\.96\d+ ERG max/); // what the fixture world left the party after its setup
    walletButton("disconnect").click();
    await settle();
    expect(walletButton("sign with your phone").textContent).toBe(
      `sign with your phone (${w.me.address.encode().slice(0, 8)}…${w.me.address.encode().slice(-6)})`,
    );
    expect(walletButton("change")).toBeDefined();
  });

  it("refuses an address that is not mainnet", async () => {
    window.prompt = () => "3Wx7Z8FywaL4ofunDCV1NaTJX5CpjTubMrjpCkEhnNBAgJLGfRcD";
    await choosePhone();
    expect(text("log")).toContain("phone: not a mainnet address");
    expect(text("wallet")).not.toContain("phone:");
  });

  it("shows the code and link for a swap, waits, and reports the id the explorer lists", async () => {
    await choosePhone();
    type("swap-in", "1");
    el<HTMLButtonElement>("swap-go").click();
    await settle(100);
    const panel = el("ergopay");
    expect(panel.hidden).toBe(false);
    expect(el<HTMLAnchorElement>("ergopay-link").getAttribute("href")).toMatch(/^ergopay:[A-Za-z0-9_-]+=*$/);
    expect(text("ergopay-txid")).toBe(TXID);
    expect(text("ergopay-status")).toBe("waiting for the wallet, 20 min left");
    expect(fake.calls.headers.length).toBe(10);
    const sent = JSON.parse(fake.calls.json) as { inputs: { boxId: string }[] };
    expect(sent.inputs.length).toBeGreaterThanOrEqual(2); // the pool box and the visitor's, from the explorer by address
    expect(fake.calls.inputs).toBe(sent.inputs.length);
    expect(text("log")).toContain("reduced to 900 bytes, a 1208-character link");
    expect(text("log")).toContain("waiting for the phone");
    w.world.mempool = [TXID];
    await settle(100);
    expect(panel.hidden).toBe(true);
    expect(text("log")).toContain(`submitted ${TXID}`);
  });

  it("cancel stops the wait", async () => {
    await choosePhone();
    type("swap-in", "1");
    el<HTMLButtonElement>("swap-go").click();
    await settle(50);
    expect(el("ergopay").hidden).toBe(false);
    el<HTMLButtonElement>("ergopay-cancel").click();
    await settle(100);
    expect(el("ergopay").hidden).toBe(true);
    expect(text("log")).toContain("cancelled");
  });

  it("asks the phone for the matured bond's hand-over from the upkeep timer", async () => {
    await choosePhone(true);
    await settle(100);
    expect(el("ergopay").hidden).toBe(false);
    const sent = JSON.parse(fake.calls.json) as { inputs: { boxId: string }[] };
    expect(sent.inputs.some((i) => i.boxId === w.bonds.utxos.at(0).boxId)).toBe(true);
    w.world.confirmed = [TXID];
    await settle(100);
    expect(text("log")).toMatch(
      /upkeep lender-collateral: bond \w{8} matured at \d+; its collateral to you; submitted/,
    );
  });
});

describe("a transaction too large for a code", () => {
  it("is refused with the size, and nothing is shown", async () => {
    const w = makeWorld();
    installFetch(w.world);
    noWallet();
    const fake = fakeErgoLib(TXID, new Uint8Array(2200));
    vi.doMock(LIB, () => fake.lib);
    window.prompt = () => w.me.address.encode();
    await loadPage();
    el<HTMLInputElement>("upkeep-on").checked = false;
    [...el("wallet").querySelectorAll("button")].find((b) => b.textContent === "sign with your phone")!.click();
    await settle(50);
    type("swap-in", "1");
    el<HTMLButtonElement>("swap-go").click();
    await settle(100);
    expect(el("ergopay").hidden).toBe(true);
    expect(text("log")).toContain("2944 characters, above the 2800 a QR code can carry");
    vi.doUnmock(LIB);
  });
});
