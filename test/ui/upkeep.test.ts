// @vitest-environment happy-dom
// Upkeep with a wallet: the keyless takes go through the explorer; a matured bond the visitor lent on is handed to
// them through their wallet, asked once.
import { beforeEach, describe, expect, it } from "vitest";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { makeWorld } from "./fixtures";
import { connect, el, installFetch, installWallet, loadPage, settle, text, type WalletStub } from "./harness";

describe("upkeep", () => {
  let w: ReturnType<typeof makeWorld>;
  let api: WalletStub;
  beforeEach(async () => {
    w = makeWorld();
    installFetch(w.world);
    api = installWallet(w.chain, w.me);
    await loadPage();
  });

  it("asks the wallet to sign the collateral hand-over of the matured bond, once", async () => {
    await connect();
    await settle(100);
    expect(w.world.submitted.length).toBeGreaterThanOrEqual(1); // the Babel bid above the pool, keyless
    expect(api.sign_tx).toHaveBeenCalledTimes(1);
    const tx = api.sign_tx.mock.calls[0][0] as EIP12UnsignedTransaction;
    const bond = w.bonds.utxos.at(0);
    expect(tx.inputs.some((i) => i.boxId === bond.boxId)).toBe(true);
    expect(tx.outputs[0].ergoTree).toBe(w.me.address.ergoTree); // the collateral to the lender, who is the visitor
    expect(BigInt(tx.outputs[0].value)).toBe(bond.value);
    expect(text("log")).toMatch(
      /upkeep lender-collateral: bond \w{8} matured at \d+; its collateral to you; submitted/,
    );
    expect(text("upkeep-status")).toMatch(/due, \d+ submitted\)$/);
    // a second round does not ask again
    const on = el<HTMLInputElement>("upkeep-on");
    on.checked = false;
    on.dispatchEvent(new Event("change"));
    on.checked = true;
    on.dispatchEvent(new Event("change"));
    await settle(100);
    expect(api.sign_tx).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the checkbox is off", async () => {
    const on = el<HTMLInputElement>("upkeep-on");
    on.checked = false;
    await connect();
    await settle(100);
    expect(api.sign_tx).not.toHaveBeenCalled();
    expect(w.world.submitted).toEqual([]);
  });
});
