// @vitest-environment happy-dom
// The Programs tab: the quote for a new program, the visitor's own programs with their next due height and legs
// left, cancel through the wallet, the create form, and the upkeep runner executing a due leg of a stranger's program.
import { beforeEach, describe, expect, it } from "vitest";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { CLOCK_TREE, describeClock } from "../../src/clock";
import { makeWorld, SIGUSD } from "./fixtures";
import {
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

describe("programs", () => {
  let w: ReturnType<typeof makeWorld>;
  let api: WalletStub;
  beforeEach(async () => {
    w = makeWorld();
    installFetch(w.world);
    api = installWallet(w.chain, w.me);
    await loadPage();
    el<HTMLInputElement>("upkeep-on").checked = false; // the runner is exercised by the last case only
  });

  it("quotes a program from the form before any wallet, and lists open programs", async () => {
    tab("programs");
    await settle(100);
    type("prog-token", SIGUSD);
    type("prog-amount", "0.3");
    type("prog-slice", "0.1");
    type("prog-interval", "720");
    await settle();
    const q = rows("prog-quote");
    expect(q["legs"]).toBe("3, one every 720 blocks (about 1 day)");
    expect(q["per leg"]).toMatch(/^0.1 ERG into the pool, 0.0015 ERG to whoever runs it$/);
    expect(q["executor keeps"]).toMatch(/^0.0004 ERG/);
    expect(q["rent reserve"]).toMatch(/ERG held in the box, back to you with the last leg \(\d+ bytes\)$/);
    expect(text("prog-interval-days")).toBe("(about 1 day)");
    expect(el<HTMLButtonElement>("prog-go").disabled).toBe(true); // no wallet
    expect(text("programs-mine")).toBe("connect a wallet to see your programs");
    const list = el("programs-list").querySelector("table")!;
    expect(column(list, 0)).toEqual(["RSN", "RSN"]);
    expect(column(list, 3)).toEqual([
      expect.stringMatching(/\(due now\)$/),
      expect.stringMatching(/\(in \d+ blocks\)$/),
    ]);
    expect(column(list, 4)).toEqual(["3", "3"]);
  });

  it("with a wallet: the visitor's program first, cancel through the wallet, and a new program from the form", async () => {
    await connect();
    tab("programs");
    await settle(100);
    const mine = el("programs-mine").querySelector("table")!;
    expect(column(mine, 2)).toEqual(["720 blocks (about 1 day)"]);
    expect(column(mine, 6)[0]).toMatch(/\(you\)$/);
    expect(el("programs-list").querySelector("table")!.querySelectorAll("tbody tr").length).toBe(1);
    // cancel: the wallet signs a transaction whose only input is the program box, everything back to the visitor
    mine.querySelector("button")!.click();
    await settle(100);
    expect(api.sign_tx).toHaveBeenCalledTimes(1);
    const cancel = api.sign_tx.mock.calls[0][0] as EIP12UnsignedTransaction;
    const myBox = w.programs.utxos.toArray().find((b) => describeClock(b).owner === w.me.address.encode())!;
    expect(cancel.inputs.map((i) => i.boxId)).toEqual([myBox.boxId]);
    expect(cancel.outputs[0].ergoTree).toBe(w.me.address.ergoTree);
    expect(BigInt(cancel.outputs[0].value)).toBe(myBox.value - 1_000_000n);
    // create: 0.03 ERG in three slices every 3 blocks with a 0.0015 fee
    type("prog-token", SIGUSD);
    type("prog-amount", "0.03");
    type("prog-slice", "0.01");
    type("prog-interval", "3");
    type("prog-tolerance", "0.5");
    type("prog-cap", "0.06");
    type("prog-fee", "0.0015");
    await settle();
    expect(el<HTMLButtonElement>("prog-go").disabled).toBe(false);
    el<HTMLFormElement>("create-program").requestSubmit();
    await settle(100);
    expect(api.sign_tx).toHaveBeenCalledTimes(2);
    const tx = api.sign_tx.mock.calls[1][0] as EIP12UnsignedTransaction;
    expect(tx.outputs[0].ergoTree).toBe(CLOCK_TREE);
    const v = describeClock({ ...tx.outputs[0], boxId: "", transactionId: "", index: 0 });
    expect(v.owner).toBe(w.me.address.encode());
    expect(v.tokenId).toBe(SIGUSD);
    expect(v.slice).toBe(10_000_000n);
    expect(v.interval).toBe(3n);
    expect(v.toleranceBps).toBe(50n);
    expect(v.maxPrice).toBe(600_000n); // 0.06 ERG per SigUSD, two decimals: 600,000 nanoERG per unit
    expect(v.executorFee).toBe(1_500_000n);
    expect(v.legsLeft).toBe(3);
    expect(v.value).toBe(3n * 11_500_000n + v.rentReserve);
    expect(text("log")).toMatch(/submitted/);
  });

  it("the upkeep runner executes the due leg of a stranger's program, keyless, the fee to the visitor", async () => {
    await connect();
    const on = el<HTMLInputElement>("upkeep-on");
    on.checked = true;
    on.dispatchEvent(new Event("change"));
    await settle(150);
    const strangerBox = w.programs.utxos.toArray().find((b) => describeClock(b).owner === w.stranger.address.encode())!;
    const legs = w.world.submitted
      .map(
        (j) =>
          JSON.parse(j) as {
            inputs: { boxId: string; spendingProof: { proofBytes: string } }[];
            outputs: { ergoTree: string; value: number }[];
          },
      )
      .filter((t) => t.inputs.some((i) => i.boxId === strangerBox.boxId));
    expect(legs.length).toBe(1);
    expect(legs[0].inputs.every((i) => i.spendingProof.proofBytes === "")).toBe(true);
    expect(legs[0].outputs[1].ergoTree).toBe(w.stranger.address.ergoTree); // the tokens to the program's owner
    expect(legs[0].outputs[2].ergoTree).toBe(CLOCK_TREE); // the successor
    expect(legs[0].outputs[3].ergoTree).toBe(w.me.address.ergoTree); // the executor fee to the visitor
    expect(text("log")).toMatch(
      /upkeep clock-legs: program \w{8} on \w{8}: 100000000 nanoERG for \d+ units to its owner, 400000 nanoERG to you; submitted/,
    );
  });
});
