// The explorer parser must keep amounts past 2^53 exact: every ErgoDEX pool's LP token is near 2^63.
import { describe, expect, it } from "vitest";
import { ErgoBox } from "@fleet-sdk/core";
import { parseExact, toFleetBox } from "../src/explorer";
import raw from "./fixtures/pool-box.json?raw";

describe("parseExact", () => {
  it("keeps a 2^63-scale amount exact and leaves other numbers alone", () => {
    const text = '{"items":[{"value":23930988,"index":0,"assets":[{"tokenId":"aa","amount":9223372036854016340}]}],"total":1}';
    const j = parseExact(text) as { items: { value: bigint; index: number; assets: { amount: bigint }[] }[]; total: number };
    expect(j.items[0].assets[0].amount).toBe(9223372036854016340n);
    expect(j.items[0].value).toBe(23930988n);
    expect(j.items[0].index).toBe(0);
    expect(j.total).toBe(1);
  });

  it("a real pool box from the explorer re-hashes to its own id after conversion", () => {
    // captured 2026-10-29 from /api/v1/boxes/74ecab76…: an rsADA dust pool whose LP amount is 9223372036854016340
    const box = toFleetBox(parseExact(raw) as Parameters<typeof toFleetBox>[0]);
    expect(ErgoBox.validate(box)).toBe(true);
    // and the naive parse would not
    const naive = toFleetBox(JSON.parse(raw));
    expect(ErgoBox.validate(naive)).toBe(false);
  });
});
