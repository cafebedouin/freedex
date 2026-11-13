// @vitest-environment happy-dom
// The LithosDex tab: the recorded mainnet pool and vault boxes in the stubbed explorer, a swap order owned by the
// visitor, and a provision whose ownership NFT the visitor holds. Each action hands the wallet the transaction the
// builder makes.
import { beforeEach, describe, expect, it } from "vitest";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoBox } from "@fleet-sdk/core";
import { hex } from "@fleet-sdk/crypto";
import { SColl, SByte } from "@fleet-sdk/serializer";
import { LIT, VAULT_TREE, describeOrder, describePool, orderTree } from "../../src/protocols/lithos/lithos";
import { formatUnits } from "../../src/units";
import { RECORD } from "../lithos-record";
import { makeWorld } from "./fixtures";
import {
  connect,
  el,
  installFetch,
  installWallet,
  loadPage,
  noWallet,
  rows,
  settle,
  tab,
  type,
  type WalletStub,
} from "./harness";

const NFT = "c7".repeat(32);

function lithosWorld() {
  const w = makeWorld();
  const mePk = hex.encode(w.me.address.getPublicKeys()[0]);
  const recorded = RECORD.orders.find((o) => o.kind === "swap-sell")!.box;
  const v = describeOrder(recorded)!;
  const box = (b: typeof recorded, patch: Partial<typeof recorded>) => {
    const c = { ...b, ...patch };
    const e = new ErgoBox(
      {
        value: c.value,
        ergoTree: c.ergoTree,
        creationHeight: c.creationHeight,
        assets: c.assets,
        additionalRegisters: c.additionalRegisters,
      },
      b.transactionId,
      b.index,
    );
    return {
      boxId: e.boxId,
      transactionId: e.transactionId,
      index: e.index,
      value: e.value,
      ergoTree: e.ergoTree,
      creationHeight: e.creationHeight,
      assets: e.assets,
      additionalRegisters: e.additionalRegisters,
    };
  };
  const myOrder = box(recorded, { ergoTree: orderTree("swap-sell", { ...v.terms, owner: mePk }) });
  const claim = RECORD.claims[0];
  const vault = claim.inputBoxes[0];
  const prov = claim.inputBoxes[1];
  const myProvision = box(prov, {
    additionalRegisters: { ...prov.additionalRegisters, R6: SColl(SByte, hex.decode(NFT)).toHex() },
  });
  w.me.addBalance({ nanoergs: 1_000_000_000n, tokens: [{ tokenId: NFT, amount: 1n }] });
  w.world.boxes.push(RECORD.poolBox, vault, myOrder, myProvision);
  w.world.tokens[LIT] = { name: "LIT", decimals: 9 };
  return { ...w, myOrder, myProvision, vault };
}

describe("LithosDex tab", () => {
  let w: ReturnType<typeof lithosWorld>;
  beforeEach(() => {
    w = lithosWorld();
    installFetch(w.world);
  });

  it("shows the pool and the vault, and asks for a wallet for the rest", async () => {
    noWallet();
    await loadPage();
    tab("lithos");
    await settle(100);
    const r = rows("lithos-pool");
    const p = describePool(RECORD.poolBox);
    expect(r["ERG reserve"]).toBe(`${formatUnits(p.reservesX, 9, 6)} ERG`);
    expect(r["LIT reserve"]).toBe(`${formatUnits(p.reservesY, 9, 4)} LIT`);
    expect(r["Fees"]).toBe("0.15% to the pool, 0.15% (ERG in) or 0.15% (LIT in) to providers");
    expect(r["Fee vault"]).toMatch(/^3\.3198\d* ERG, /);
    expect(el("lithos-orders").textContent).toBe("connect a wallet to see your orders");
    expect(el("tab-lithos").textContent).toContain("Nautilus 1.4 cannot sign them");
  });

  describe("with a wallet", () => {
    let wallet: WalletStub;
    beforeEach(async () => {
      wallet = installWallet(w.chain, w.me);
      await loadPage();
      el<HTMLInputElement>("upkeep-on").checked = false;
      await connect();
      tab("lithos");
      await settle(150);
    });
    const signed = () => wallet.sign_tx.mock.calls.at(-1)![0] as EIP12UnsignedTransaction;

    it("lists the visitor's order; cancel hands the wallet the refund with the order at input 0", async () => {
      const t = el("lithos-orders").querySelector("table")!;
      expect(t.querySelectorAll("tbody tr").length).toBe(1);
      expect(t.textContent).toContain("swap ERG for LIT");
      const b = [...t.querySelectorAll("button")].find((x) => x.textContent === "cancel")!;
      b.click();
      await settle(100);
      const tx = signed();
      expect(tx.inputs[0].boxId).toBe(w.myOrder.boxId);
      expect(el("log").textContent).toMatch(/Cancel the LithosDex swap ERG for LIT order: .* reads ErgoTree version 3/);
    });

    it("lists the provision the visitor's NFT owns; claim spends the vault, the provision and the NFT box", async () => {
      const t = el("lithos-provisions").querySelector("table")!;
      expect(t.querySelectorAll("tbody tr").length).toBe(1);
      expect([...t.querySelectorAll("button")].map((x) => x.textContent)).toEqual(["claim", "redeem order"]);
      t.querySelector("button")!.click();
      await settle(100);
      const tx = signed();
      expect(tx.inputs[0].boxId).toBe(w.vault.boxId);
      expect(tx.inputs[1].boxId).toBe(w.myProvision.boxId);
      expect(tx.inputs.some((i) => i.assets.some((a) => a.tokenId === NFT))).toBe(true);
      expect(tx.outputs[0].ergoTree).toBe(VAULT_TREE);
      expect(tx.inputs[1].extension["0"]).toBe("0200");
    });

    it("quotes a swap order and hands the wallet the order box", async () => {
      type("ld-amount", "1");
      expect(el("ld-quote").textContent).toMatch(/^the pool would pay [\d.]+ LIT now; the order asks at least/);
      el<HTMLFormElement>("ld-swap").requestSubmit();
      await settle(100);
      const tx = signed();
      const v = describeOrder({ ...tx.outputs[0], boxId: "00".repeat(32), transactionId: "00".repeat(32), index: 0 });
      expect(v?.kind).toBe("swap-sell");
      expect(v?.owner).toBe(w.me.address.encode());
      expect(v?.terms.baseAmount).toBe(1_000_000_000n);
      expect(BigInt(tx.outputs[0].value)).toBe(1_000_000_000n + 3_000_000n + 1_000_000n);
    });

    it("quotes a deposit order at the pool's ratio", async () => {
      type("ld-dep-erg", "2");
      expect(el("ld-dep-quote").textContent).toMatch(/^with [\d.]+ LIT at the pool's ratio: about \d+ shares/);
    });
  });
});
