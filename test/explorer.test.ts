// The explorer parser must keep amounts past 2^53 exact: every ErgoDEX pool's LP token is near 2^63.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErgoBox } from "@fleet-sdk/core";
import { Explorer, parseExact, toFleetBox, type ExplorerStatus } from "../src/explorer";
import raw from "./fixtures/pool-box.json?raw";

describe("parseExact", () => {
  it("keeps a 2^63-scale amount exact and leaves other numbers alone", () => {
    const text =
      '{"items":[{"value":23930988,"index":0,"assets":[{"tokenId":"aa","amount":9223372036854016340}]}],"total":1}';
    const j = parseExact(text) as {
      items: { value: bigint; index: number; assets: { amount: bigint }[] }[];
      total: number;
    };
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

describe("retry with backoff inside the failover loop", () => {
  const A = "https://a.example",
    B = "https://b.example";
  const ok = (body: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) }) as Response;
  afterEach(() => vi.unstubAllGlobals());

  function explorer(script: (base: string, n: number) => Response | Error) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const statuses: ExplorerStatus[] = [];
    const counts = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const base = new URL(url).origin === A ? A : B;
        const n = (counts.get(base) ?? 0) + 1;
        counts.set(base, n);
        calls.push(`${base === A ? "a" : "b"}${n}`);
        const r = script(base, n);
        if (r instanceof Error) throw r;
        return r;
      }),
    );
    const ex = new Explorer(A, [A, B]);
    ex.sleep = async (ms) => {
      sleeps.push(ms);
    };
    ex.onStatus = (s) => statuses.push(s);
    return { ex, calls, sleeps, statuses };
  }

  it("a backend that fails twice then answers is retried after 1 s and 2 s, and the second backend is never asked", async () => {
    const { ex, calls, sleeps, statuses } = explorer((_, n) =>
      n < 3 ? new TypeError("fetch failed") : ok({ height: 7 }),
    );
    expect(await ex.height()).toBe(7);
    expect(calls).toEqual(["a1", "a2", "a3"]);
    expect(sleeps).toEqual([1000, 2000]);
    expect(statuses.map((s) => `${s.state}:${s.attempt}`)).toEqual(["retrying:1", "retrying:2", "ok:3"]);
    expect(ex.base).toBe(A);
  });

  it("after four failed tries (1 s, 2 s, 4 s between them) the next backend is tried; a 5xx and a 429 count as failures", async () => {
    const { ex, calls, sleeps, statuses } = explorer((base, n) =>
      base === A ? ({ status: n % 2 ? 503 : 429, ok: false, text: async () => "" } as Response) : ok({ height: 9 }),
    );
    const seen: string[] = [];
    ex.onBaseChange = (b) => seen.push(b);
    expect(await ex.height()).toBe(9);
    expect(calls).toEqual(["a1", "a2", "a3", "a4", "b1"]);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(statuses.at(-1)).toMatchObject({ state: "ok", base: B });
    expect(seen).toEqual([B]);
  });

  it("when every backend fails every try, the error is thrown once with a 'failed' status, after eight tries", async () => {
    const { ex, calls, sleeps, statuses } = explorer(() => new Error("explorer 502 on /x"));
    await expect(ex.height()).rejects.toThrow(/502/);
    expect(calls.length).toBe(8);
    expect(sleeps).toEqual([1000, 2000, 4000, 1000, 2000, 4000]);
    expect(statuses.filter((s) => s.state === "retrying").length).toBe(6);
    expect(statuses.at(-1)).toMatchObject({ state: "failed", error: "explorer 502 on /x" });
  });

  it("a 404 is not retried and not failed over: it is the answer", async () => {
    const { ex, calls, sleeps } = explorer(() => ({ status: 404, ok: false, text: async () => "no" }) as Response);
    await expect(ex.token("00")).rejects.toThrow(/404/);
    expect(calls).toEqual(["a1"]);
    expect(sleeps).toEqual([]);
  });
});
