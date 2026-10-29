// @vitest-environment happy-dom
// The Options tab: the quote for a new option, the open offers grouped by token, the visitor's positions with the
// buttons the contract allows, buy and exercise and write through the wallet, and the upkeep timer reclaiming an
// expired option the visitor wrote.
import { beforeEach, describe, expect, it } from "vitest";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { CALL_TREE, PUT_TREE, describeOption } from "../../src/option";
import { makeWorld, SIGUSD } from "./fixtures";
import {
  choose,
  column,
  connect,
  el,
  installFetch,
  installWallet,
  loadPage,
  rows,
  settle,
  tab,
  text,
  type,
  type WalletStub,
} from "./harness";

describe("options", () => {
  let w: ReturnType<typeof makeWorld>;
  let api: WalletStub;
  beforeEach(async () => {
    w = makeWorld();
    installFetch(w.world);
    api = installWallet(w.chain, w.me);
  });

  it("quotes a call and a put from the form before any wallet, and lists the open offers grouped by token", async () => {
    await loadPage();
    el<HTMLInputElement>("upkeep-on").checked = false;
    tab("options");
    await settle(100);
    type("opt-token", SIGUSD);
    type("opt-amount", "10");
    type("opt-strike", "0.06");
    type("opt-expiry", "720");
    type("opt-premium", "0.002");
    await settle();
    const q = rows("opt-quote");
    expect(q["expiry"]).toBe(
      `height ${w.world.height + 720}, 720 blocks (about 1 day) from now; exercisable at or before it`,
    );
    expect(q["premium"]).toMatch(/^0.002 ERG to you when someone buys/);
    expect(q["locked now"]).toMatch(/^10 SigUSD and 0\.\d+ ERG plus the miner fee$/);
    expect(q["rent reserve"]).toMatch(/^0\.\d+ ERG, one storage-rent fee for \d+ bytes/);
    expect(q["on exercise"]).toBe("you receive 0.6 ERG (the strike) and the reserve; the buyer takes the SigUSD");
    expect(text("opt-expiry-days")).toBe("(about 1 day)");
    expect(el<HTMLButtonElement>("opt-go").disabled).toBe(true); // no wallet
    choose("opt-side", "put");
    expect(text("opt-amount-label")).toBe("Tokens the buyer may sell you");
    await settle();
    const qp = rows("opt-quote");
    expect(qp["locked now"]).toBe("0.6 ERG, the collateral (strike x amount), plus the miner fee");
    expect(qp["on exercise"]).toBe("you receive 10 SigUSD; the buyer takes the 0.6 ERG");
    expect(qp["rent reserve"]).toBeUndefined();
    // a strike the contract cannot hold
    type("opt-strike", "0.000000001"); // one nanoERG per SigUSD: not a whole number per unit
    await settle();
    expect(rows("opt-quote")[""]).toMatch(/multiple of/);
    // the listing without a wallet: the stranger's unsold call and put on SigUSD and the visitor's own unsold call
    // (nobody's yet); the sold call is not an offer
    expect(text("options-mine")).toBe("connect a wallet to see your options");
    const list = el("options-list");
    expect([...list.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["SigUSD (3)"]);
    const t = list.querySelector("table")!;
    expect(column(t, 1)).toEqual(["put", "call", "call"]); // the cheapest premium first
    expect(column(t, 2)).toEqual(["1 SigUSD", "1 SigUSD", "1 SigUSD"]);
    expect(column(t, 3)).toEqual(["0.04 ERG", "0.06 ERG", "0.06 ERG"]);
    expect(column(t, 4)).toEqual(["0.001 ERG", "0.002 ERG", "0.002 ERG"]);
    expect(column(t, 5)).toEqual([
      expect.stringMatching(/^\d+ \(in 49\d blocks\)$/),
      expect.stringMatching(/^\d+ \(in 49\d blocks\)$/),
      expect.stringMatching(/^\d+ \(in 4\d blocks\)$/),
    ]);
    expect(column(t, 7)).toEqual(["unsold", "unsold", "unsold"]);
    expect(t.querySelectorAll("button").length).toBe(0);
  });

  it("with a wallet: positions with exercise and cancel, buy an offer, exercise the held call, write a put", async () => {
    await loadPage();
    el<HTMLInputElement>("upkeep-on").checked = false;
    await connect();
    tab("options");
    await settle(100);
    const mine = el("options-mine").querySelector("table")!;
    expect(column(mine, 1)).toEqual(["call", "call"]);
    const buyers = column(mine, 7);
    const held = buyers.findIndex((b) => b.endsWith("(you)"));
    const written = buyers.findIndex((b) => b === "unsold");
    expect(held).toBeGreaterThanOrEqual(0);
    expect(written).toBeGreaterThanOrEqual(0);
    expect(column(mine, 6)[written]).toMatch(/\(you\)$/);
    const buttonsOf = (i: number) =>
      [...mine.querySelectorAll("tbody tr")[i].querySelectorAll("button")].map((b) => b.textContent);
    expect(buttonsOf(held)).toEqual(["exercise"]);
    expect(buttonsOf(written)).toEqual(["cancel"]); // unsold: cancel any time; no buy button on your own offer
    // exercise the held call: the wallet signs; the strike plus the reserve to the writer, the tokens to the visitor
    const heldBox = w.calls.utxos.toArray().find((b) => describeOption(b).buyer === w.me.address.encode())!;
    mine.querySelectorAll("tbody tr")[held].querySelector("button")!.click();
    await settle(100);
    expect(api.sign_tx).toHaveBeenCalledTimes(1);
    const ex = api.sign_tx.mock.calls[0][0] as EIP12UnsignedTransaction;
    expect(ex.inputs.some((i) => i.boxId === heldBox.boxId)).toBe(true);
    expect(ex.outputs[0].ergoTree).toBe(w.stranger.address.ergoTree);
    expect(BigInt(ex.outputs[0].value)).toBe(heldBox.value + 600_000n * 100n);
    expect(ex.outputs[1].ergoTree).toBe(w.me.address.ergoTree);
    expect(ex.outputs[1].assets).toEqual([{ tokenId: SIGUSD, amount: "100" }]);
    // buy the stranger's call: the premium to the stranger, the successor with the visitor in R7
    const offers = el("options-list").querySelector("table")!;
    const callRow = [...offers.querySelectorAll("tbody tr")].find((tr) => tr.children[1].textContent === "call")!;
    expect([...callRow.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["pay the premium and buy"]);
    callRow.querySelector("button")!.click();
    await settle(100);
    expect(api.sign_tx).toHaveBeenCalledTimes(2);
    const buy = api.sign_tx.mock.calls[1][0] as EIP12UnsignedTransaction;
    expect(buy.outputs[0].ergoTree).toBe(w.stranger.address.ergoTree);
    expect(BigInt(buy.outputs[0].value)).toBe(2_000_000n);
    expect(buy.outputs[1].ergoTree).toBe(CALL_TREE);
    const bought = describeOption({ ...buy.outputs[1], boxId: "", transactionId: "", index: 0 });
    expect(bought.sold).toBe(true);
    expect(bought.buyer).toBe(w.me.address.encode());
    expect(bought.amount).toBe(100n);
    // write a put from the form: 10 SigUSD at 0.05 ERG, 0.5 ERG of collateral, 0.001 premium, 100 blocks
    choose("opt-side", "put");
    type("opt-token", SIGUSD);
    type("opt-amount", "10");
    type("opt-strike", "0.05");
    type("opt-expiry", "100");
    type("opt-premium", "0.001");
    await settle();
    expect(el<HTMLButtonElement>("opt-go").disabled).toBe(false);
    el<HTMLFormElement>("write-option").requestSubmit();
    await settle(100);
    expect(api.sign_tx).toHaveBeenCalledTimes(3);
    const wr = api.sign_tx.mock.calls[2][0] as EIP12UnsignedTransaction;
    expect(wr.outputs[0].ergoTree).toBe(PUT_TREE);
    expect(wr.outputs[0].assets).toEqual([]);
    const v = describeOption({ ...wr.outputs[0], boxId: "", transactionId: "", index: 0 });
    expect(v.side).toBe("put");
    expect(v.writer).toBe(w.me.address.encode());
    expect(v.sold).toBe(false);
    expect(v.amount).toBe(1_000n);
    expect(v.strike).toBe(500_000n); // 0.05 ERG per SigUSD, two decimals
    expect(v.strikeTotal).toBe(500_000_000n);
    expect(v.value).toBe(500_000_000n);
    expect(v.expiry).toBe(w.chain.height + 100);
    expect(v.premium).toBe(1_000_000n);
    expect(text("log")).toMatch(/submitted/);
  });

  it("the upkeep timer asks the wallet to reclaim an expired option the visitor wrote, once", async () => {
    w.world.height = w.chain.height + 60; // past the visitor's own call (expiry + 50), not the others
    await loadPage();
    await connect();
    await settle(150);
    const myCall = w.calls.utxos.toArray().find((b) => describeOption(b).writer === w.me.address.encode())!;
    const signed = api.sign_tx.mock.calls.map((c) => c[0] as EIP12UnsignedTransaction);
    const reclaims = signed.filter((t) => t.inputs.some((i) => i.boxId === myCall.boxId));
    expect(reclaims.length).toBe(1);
    expect(reclaims[0].outputs[0].ergoTree).toBe(w.me.address.ergoTree);
    expect(BigInt(reclaims[0].outputs[0].value)).toBe(myCall.value);
    expect(reclaims[0].outputs[0].assets).toEqual([{ tokenId: SIGUSD, amount: "100" }]);
    expect(text("log")).toMatch(
      /upkeep option-reclaim: call \w{8} expired at \d+; its tokens and reserve to you; submitted/,
    );
    // the held call (not expired, not the visitor's to reclaim) and the stranger's offers are left alone
    expect(
      signed.filter((t) => t.inputs.some((i) => w.calls.utxos.toArray().some((b) => b.boxId === i.boxId))).length,
    ).toBe(1);
    // a second round does not ask again
    const on = el<HTMLInputElement>("upkeep-on");
    on.checked = false;
    on.dispatchEvent(new Event("change"));
    on.checked = true;
    on.dispatchEvent(new Event("change"));
    await settle(100);
    expect(api.sign_tx.mock.calls.length).toBe(signed.length);
    // and on the tab, the expired written call shows "reclaim" only
    tab("options");
    await settle(100);
    const mine = el("options-mine").querySelector("table")!;
    const row = [...mine.querySelectorAll("tbody tr")].find((tr) => tr.children[6].textContent?.endsWith("(you)"))!;
    expect(row.children[5].textContent).toMatch(/\(expired\)$/);
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["reclaim"]);
  });
});
