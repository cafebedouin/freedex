// Tip consistency (src/tip.ts): the check `send` runs on the boxes the page brought before the signer sees a
// transaction, and the plain words for the refusals a wallet or its node gives. docs/invariants/signing.md.
import { describe, expect, it } from "vitest";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import type { BoxState } from "../src/explorer";
import {
  FAILURE_NOTES,
  MIN_CONFIRMATIONS,
  TipRefusal,
  checkInputs,
  explainFailure,
  failureText,
  judgeBox,
} from "../src/tip";

const ID = "ab".repeat(32);
const refusal = (f: () => void): TipRefusal => {
  try {
    f();
  } catch (e) {
    if (e instanceof TipRefusal) return e;
    throw e;
  }
  throw new Error("not refused");
};

describe("judgeBox", () => {
  const wallet = { kind: "eip12" as const, height: 1_915_000 };
  const phone = { kind: "ergopay" as const, height: 1_915_000 };

  it("takes a box the wallet's node has (one confirmation against the wallet's height) and a followed mempool box", () => {
    expect(MIN_CONFIRMATIONS).toEqual({ eip12: 1, ergopay: 2 });
    expect(() => judgeBox(ID, { state: "confirmed", height: 1_915_000 }, wallet)).not.toThrow();
    expect(() => judgeBox(ID, { state: "mempool" }, wallet)).not.toThrow();
  });

  it("refuses a box confirmed in a block the wallet does not report yet, with the wait", () => {
    const r = refusal(() => judgeBox(ID, { state: "confirmed", height: 1_915_001 }, wallet));
    expect(r.code).toBe("too-fresh");
    expect(r.boxId).toBe(ID);
    expect(r.message).toBe(
      "box abababab… was confirmed in block 1915001; your wallet reports block 1915000, so its node may not have that block yet. Nothing was signed: wait 1 block (about 2 minutes) and press the button again",
    );
    expect(refusal(() => judgeBox(ID, { state: "confirmed", height: 1_915_003 }, wallet)).message).toMatch(
      /wait 3 blocks \(about 6 minutes\)/,
    );
  });

  it("on the phone path wants two confirmations against the explorer's height", () => {
    expect(() => judgeBox(ID, { state: "confirmed", height: 1_914_999 }, phone)).not.toThrow();
    const r = refusal(() => judgeBox(ID, { state: "confirmed", height: 1_915_000 }, phone));
    expect(r.code).toBe("too-fresh");
    expect(r.message).toMatch(
      /^box abababab… was confirmed in block 1915000; the explorer is at block 1915000, and the phone path waits for 2 confirmations so the phone's node has it too\. Nothing was signed: wait 1 block/,
    );
  });

  it("refuses a box spent since the page read it, and one the explorer no longer knows", () => {
    const spent = refusal(() =>
      judgeBox(ID, { state: "confirmed", height: 1_914_000, spentBy: "cd".repeat(32) }, wallet),
    );
    expect(spent.code).toBe("spent");
    expect(spent.message).toBe(
      "box abababab… was spent by transaction cdcdcdcd… after the page read it; nothing was signed; press the button again to rebuild against the newest boxes",
    );
    const gone = refusal(() => judgeBox(ID, { state: "unknown" }, wallet));
    expect(gone.code).toBe("not-visible");
    expect(gone.message).toMatch(/^box abababab… is no longer known to the explorer .* press the button again/);
  });
});

describe("checkInputs", () => {
  const tx = (inputs: string[], dataInputs: string[] = []) =>
    ({
      inputs: inputs.map((boxId) => ({ boxId })),
      dataInputs: dataInputs.map((boxId) => ({ boxId })),
      outputs: [],
    }) as unknown as EIP12UnsignedTransaction;
  const explorer = (states: Record<string, BoxState>) => {
    const asked: string[] = [];
    return {
      asked,
      boxState: async (id: string) => {
        asked.push(id);
        return states[id] ?? { state: "unknown" };
      },
    };
  };

  it("asks only for the boxes the signer did not supply, data inputs included, and returns the newest height", async () => {
    const ex = explorer({
      p: { state: "confirmed", height: 100 },
      o: { state: "confirmed", height: 90 },
      m: { state: "mempool" },
    });
    const newest = await checkInputs(ex, tx(["p", "w1", "m", "w2"], ["o"]), new Set(["w1", "w2"]), {
      kind: "eip12",
      height: 100,
    });
    expect(ex.asked.sort()).toEqual(["m", "o", "p"]);
    expect(newest).toBe(100);
  });

  it("refuses when one of them fails the check, and asks nothing for a wallet-only transaction", async () => {
    const ex = explorer({ p: { state: "confirmed", height: 101 } });
    await expect(checkInputs(ex, tx(["w", "p"]), new Set(["w"]), { kind: "eip12", height: 100 })).rejects.toThrow(
      /confirmed in block 101; your wallet reports block 100/,
    );
    const none = explorer({});
    expect(await checkInputs(none, tx(["w"]), new Set(["w"]), { kind: "eip12", height: 100 })).toBe(0);
    expect(none.asked).toEqual([]);
  });
});

describe("the wallet's refusals in plain words", () => {
  it("reads an EIP-12 {code, info} object instead of printing [object Object]", () => {
    expect(failureText({ code: 2, info: "User rejected" })).toBe("User rejected");
    expect(failureText(new Error("boom"))).toBe("boom");
    expect(failureText({ code: 1 })).toBe('{"code":1}');
    expect(failureText("text")).toBe("text");
  });

  it("names the version-3 library failure and points at the tab's note", () => {
    const m = explainFailure({ code: 1, info: "Failed to sign: NonConsumedBytes" });
    expect(m.startsWith(FAILURE_NOTES.versions)).toBe(true);
    expect(m).toMatch(/Nautilus 1\.4 fails this way, with NonConsumedBytes, until it ships sigma-rust 0\.29/);
    expect(m).toMatch(/See the experimental note at the top of the tab \(wallet: Failed to sign: NonConsumedBytes\)$/);
  });

  it("explains the node's double-spend and missing-input refusals, and leaves others as they are", () => {
    expect(explainFailure({ code: 1, info: "Double spending attempt" })).toMatch(
      /^the node refused it as a double spend: .* press the button again to rebuild against the newest boxes \(node: Double spending attempt\)$/,
    );
    const missing = "Malformed transaction: Every input of the transaction should be in UTXO. null";
    expect(explainFailure(new Error(missing))).toBe(`${FAILURE_NOTES.missingInput} (node: ${missing})`);
    expect(explainFailure(new Error("Box with id " + ID + " not found"))).toMatch(/^the wallet's node does not have/);
    expect(explainFailure({ code: 2, info: "User rejected" })).toBe("User rejected");
  });
});
