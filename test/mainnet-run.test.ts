// scripts/mainnet-run-lib.ts: which boxes a generator step spends, and the node check before it writes a file.
import { describe, expect, it } from "vitest";
import { heldIn, nodeVisibility, providerFilter, visibilityReport, withoutTokens } from "../scripts/mainnet-run-lib";

const LIT = "c1".repeat(32);
const NFT = "a7".repeat(32);
const FAKU = "f0".repeat(32);
const box = (boxId: string, tokens: [string, bigint][]) => ({
  boxId: boxId.padEnd(64, "0"),
  assets: tokens.map(([tokenId, amount]) => ({ tokenId, amount: amount.toString() })),
});

describe("providerFilter", () => {
  const clean = box("01", [[LIT, 5n]]);
  const mixed = box("02", [
    [NFT, 1n],
    [FAKU, 10n],
    [LIT, 7n],
  ]);
  const ok = new Set([LIT, NFT]);

  it("without --use, skips boxes holding tokens outside the allowed set", () => {
    expect(providerFilter([clean, mixed], ok, []).map((b) => b.boxId)).toEqual([clean.boxId]);
  });

  it("with --use, takes the named boxes as they are: a provision NFT beside other tokens can be spent", () => {
    // the caller already narrowed the list to the --use boxes; P3 then finds the NFT box
    expect(providerFilter([mixed], ok, ["02"]).map((b) => b.boxId)).toEqual([mixed.boxId]);
  });
});

describe("L4's boxes", () => {
  it("leaves the boxes holding a provision NFT alone and sells only the LIT outside them", () => {
    const boxes = [
      box("01", [[LIT, 5n]]),
      box("02", [
        [NFT, 1n],
        [LIT, 7n],
      ]),
      box("03", [[FAKU, 1n]]),
    ];
    const own = withoutTokens(boxes, new Set([NFT]));
    expect(own.map((b) => b.boxId.slice(0, 2))).toEqual(["01", "03"]);
    expect(heldIn(own, LIT)).toBe(5n);
    expect(heldIn(boxes, LIT)).toBe(12n);
  });
});

describe("the node check before writing", () => {
  const A = "aa".repeat(32),
    B = "bb".repeat(32),
    C = "cc".repeat(32),
    D = "dd".repeat(32);
  const node = "http://127.0.0.1:9053/";
  const asked: string[] = [];
  const fetchFn = async (url: string) => {
    asked.push(url);
    if (url.endsWith(`/utxo/byId/${A}`)) return { status: 200 };
    if (url.endsWith(`/utxo/withPool/byId/${B}`)) return { status: 200 };
    if (url.includes(D)) throw new Error("connect ECONNREFUSED");
    return { status: 404 };
  };

  it("asks /utxo/byId, then /utxo/withPool/byId on a 404, and refuses when a box is missing or the node fails", async () => {
    const seen = await nodeVisibility(node, [A, B, C, D], fetchFn);
    expect([...seen.values()]).toEqual(["utxo", "mempool", "missing", "error: connect ECONNREFUSED"]);
    expect(asked.slice(0, 3)).toEqual([
      `http://127.0.0.1:9053/utxo/byId/${A}`,
      `http://127.0.0.1:9053/utxo/byId/${B}`,
      `http://127.0.0.1:9053/utxo/withPool/byId/${B}`,
    ]);
    const r = visibilityReport(node, seen);
    expect(r.lines[0]).toMatch(/aaaaaaaaaaaa… in its UTXO set$/);
    expect(r.lines[1]).toMatch(/bbbbbbbbbbbb… in its mempool only/);
    expect(r.lines[2]).toMatch(/cccccccccccc… NOT VISIBLE/);
    expect(r.refuse).toMatch(/^not writing: 2 input boxes not visible at .* \(cccccccccccc…, dddddddddddd…\)/);
  });

  it("writes when every box is visible", async () => {
    const r = visibilityReport(node, await nodeVisibility(node, [A, B], fetchFn));
    expect(r.refuse).toBeUndefined();
  });
});
