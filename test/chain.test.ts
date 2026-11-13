// Chaining off the mempool: a shared box (the SigmaUSD bank) followed through unconfirmed spends to its newest
// version, and an address's boxes with its pending transactions counted. The explorer is a fake fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErgoAddress } from "@fleet-sdk/core";
import { MockChain } from "@fleet-sdk/mock-chain";
import { Explorer, MAX_CHAIN, chainUnspent, nextInChain, toFleetBox, type MempoolTx } from "../src/explorer";

const NFT = "7d".repeat(32);
const OTHER = "ab".repeat(32);
const chain = new MockChain({ height: 1_911_000 });
const treeA = chain.newParty("a").address.ergoTree;
const treeB = chain.newParty("b").address.ergoTree;
const addrA = ErgoAddress.fromErgoTree(treeA).encode();
const addrB = ErgoAddress.fromErgoTree(treeB).encode();

/** An explorer box as the API serves it; the mempool listing gives registers as bare hex. */
function box(id: string, ergoTree: string, tokens: string[] = [], bareRegisters = false) {
  return {
    boxId: id.padEnd(64, "0"),
    transactionId: "f".repeat(64),
    index: 0,
    value: 1_000_000,
    ergoTree,
    creationHeight: 1_911_000,
    assets: tokens.map((tokenId) => ({ tokenId, amount: 1 })),
    additionalRegisters: bareRegisters ? { R4: "0580897a" } : { R4: { serializedValue: "0580897a" } },
  };
}
const id = (s: string) => s.padEnd(64, "0");
const tx = (txId: string, ins: string[], outs: ReturnType<typeof box>[]): MempoolTx => ({
  id: txId,
  inputs: ins.map((i) => ({ boxId: id(i) })),
  outputs: outs,
});

describe("nextInChain", () => {
  it("finds the output that carries the token on from the transaction that spends the box", () => {
    const txs = [tx("t1", ["aa"], [box("b0", treeA), box("bb", treeA, [NFT], true)])];
    const next = nextInChain(id("aa"), NFT, txs)!;
    expect(next.boxId).toBe(id("bb"));
    expect(next.additionalRegisters).toEqual({ R4: "0580897a" }); // bare hex read as is
  });

  it("gives nothing when nothing spends the box, or the spender does not carry the token on", () => {
    expect(nextInChain(id("aa"), NFT, [])).toBeUndefined();
    expect(nextInChain(id("aa"), NFT, [tx("t1", ["aa"], [box("bb", treeA, [OTHER])])])).toBeUndefined();
    expect(nextInChain(id("aa"), NFT, [{ id: "t1" }])).toBeUndefined(); // a listing without inputs or outputs
  });
});

describe("chainUnspent", () => {
  it("drops confirmed boxes a pending transaction spends and adds its unconfirmed change to the same script", () => {
    const confirmed = [box("c1", treeA), box("c2", treeA)].map(toFleetBox);
    const txs = [tx("t1", ["c1"], [box("p1", treeB), box("p2", treeA)])];
    expect(chainUnspent(confirmed, txs, treeA).map((b) => b.boxId)).toEqual([id("c2"), id("p2")]);
  });

  it("leaves out change that a second pending transaction already spends, and counts a box once", () => {
    const confirmed = [box("c1", treeA)].map(toFleetBox);
    const txs = [
      tx("t1", ["c1"], [box("p1", treeA)]),
      tx("t2", ["p1"], [box("p2", treeA)]),
      tx("t2", ["p1"], [box("p2", treeA)]),
    ];
    expect(chainUnspent(confirmed, txs, treeA).map((b) => b.boxId)).toEqual([id("p2")]);
  });
});

describe("Explorer: latestByToken, unspentByAddressChained, the pool reads", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = (body: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) }) as Response;

  function explorer(routes: (path: string) => unknown) {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url);
        asked.push(u.pathname);
        const body = routes(u.pathname);
        if (body instanceof Error) throw body;
        return body === undefined ? ({ status: 404, ok: false, text: async () => "" } as Response) : ok(body);
      }),
    );
    const ex = new Explorer("https://x.example", ["https://x.example"]);
    ex.sleep = async () => {};
    return { ex, asked };
  }
  const MEMPOOL = "/api/v1/mempool/transactions/byAddress/";

  it("with nothing pending, the confirmed box", async () => {
    const { ex } = explorer((p) =>
      p.startsWith("/api/v1/boxes/unspent/byTokenId/") ? { items: [box("aa", treeA, [NFT])] } : { items: [], total: 0 },
    );
    expect((await ex.latestByToken(NFT)).boxId).toBe(id("aa"));
  });

  it("follows two unconfirmed spends, asking the mempool again when the script changes", async () => {
    const { ex, asked } = explorer((p) => {
      if (p.startsWith("/api/v1/boxes/unspent/byTokenId/")) return { items: [box("aa", treeA, [NFT])] };
      if (p === MEMPOOL + addrA) return { items: [tx("t1", ["aa"], [box("bb", treeB, [NFT], true)])], total: 1 };
      if (p === MEMPOOL + addrB) return { items: [tx("t2", ["bb"], [box("cc", treeB, [NFT], true)])], total: 1 };
    });
    expect((await ex.latestByToken(NFT)).boxId).toBe(id("cc"));
    // addrB asked once although two steps live there
    expect(asked.filter((p) => p.startsWith(MEMPOOL))).toEqual([MEMPOOL + addrA, MEMPOOL + addrB]);
  });

  it("boxState: a box by id, confirmed at its height and spent or not; a followed mempool output; an unknown one", async () => {
    const { ex, asked } = explorer((p) => {
      if (p.startsWith("/api/v1/boxes/unspent/byTokenId/")) return { items: [box("aa", treeA, [NFT])] };
      if (p === MEMPOOL + addrA) return { items: [tx("t1", ["aa"], [box("bb", treeA, [NFT], true)])], total: 1 };
      if (p === `/api/v1/boxes/${id("c1")}`)
        return { ...box("c1", treeA), settlementHeight: 1_911_002, spentTransactionId: null };
      if (p === `/api/v1/boxes/${id("c2")}`)
        return { ...box("c2", treeA), settlementHeight: 1_911_001, spentTransactionId: "e".repeat(64) };
      if (p.startsWith(MEMPOOL)) return { items: [], total: 0 };
    });
    expect(await ex.boxState(id("c1"))).toEqual({ state: "confirmed", height: 1_911_002 });
    expect(await ex.boxState(id("c2"))).toEqual({ state: "confirmed", height: 1_911_001, spentBy: "e".repeat(64) });
    // before the page followed the mempool to bb, a 404 for it is unknown; after, it is a mempool box
    expect(await ex.boxState(id("bb"))).toEqual({ state: "unknown" });
    expect((await ex.latestByToken(NFT)).boxId).toBe(id("bb"));
    expect(await ex.boxState(id("bb"))).toEqual({ state: "mempool" });
    expect(asked.filter((p) => p === `/api/v1/boxes/${id("c1")}`).length).toBe(1);
  });

  it("stops where it is when the mempool cannot be read, and refuses a token with no unspent box", async () => {
    const { ex } = explorer((p) => {
      if (p.startsWith("/api/v1/boxes/unspent/byTokenId/")) return { items: [box("aa", treeA, [NFT])] };
      return new TypeError("fetch failed");
    });
    expect((await ex.latestByToken(NFT)).boxId).toBe(id("aa"));
    const empty = explorer(() => ({ items: [] }));
    await expect(empty.ex.latestByToken(NFT)).rejects.toThrow(/no unspent box holds 7d7d7d7d/);
  });

  it(`stops after ${MAX_CHAIN} steps on a cycle rather than looping`, async () => {
    const { ex } = explorer((p) => {
      if (p.startsWith("/api/v1/boxes/unspent/byTokenId/")) return { items: [box("aa", treeA, [NFT])] };
      return { items: [tx("t1", ["aa"], [box("bb", treeA, [NFT])]), tx("t2", ["bb"], [box("aa", treeA, [NFT])])] };
    });
    expect([id("aa"), id("bb")]).toContain((await ex.latestByToken(NFT)).boxId);
  });

  it("an address's boxes with the pending spend left out and its change added", async () => {
    const { ex } = explorer((p) => {
      if (p === `/api/v1/boxes/unspent/byAddress/${addrA}`) return { items: [box("c1", treeA), box("c2", treeA)] };
      if (p === MEMPOOL + addrA) return { items: [tx("t1", ["c1"], [box("p1", treeA, [], true)])], total: 1 };
    });
    expect((await ex.unspentByAddressChained(addrA)).map((b) => b.boxId)).toEqual([id("c2"), id("p1")]);
  });

  const LP = "1c".repeat(32);
  const TOK = "cd".repeat(32);
  const TOK2 = "ef".repeat(32);
  /** a pool box: NFT, LP token, then the pooled token(s), named as the explorer names them */
  function pool(boxId: string, tokens: string[]) {
    const b = box(boxId, treeA, tokens);
    b.assets = b.assets.map((a, i) => (i >= 2 ? { ...a, name: `T${i}`, decimals: i } : a));
    return b;
  }

  it("poolByNft and t2tPoolByNft build after a pending swap on the same pool, the names from the confirmed box", async () => {
    const { ex } = explorer((p) => {
      if (p === `/api/v1/boxes/unspent/byTokenId/${NFT}`) return { items: [pool("aa", [NFT, LP, TOK])] };
      if (p === `/api/v1/boxes/unspent/byTokenId/${OTHER}`) return { items: [pool("dd", [OTHER, LP, TOK, TOK2])] };
      if (p === MEMPOOL + addrA)
        return {
          items: [
            tx("t1", ["aa", "u1"], [box("bb", treeA, [NFT, LP, TOK]), box("u2", treeB)]),
            tx("t2", ["dd"], [box("ee", treeA, [OTHER, LP, TOK, TOK2])]),
          ],
        };
    });
    const n2t = await ex.poolByNft(NFT);
    expect(n2t.box.boxId).toBe(id("bb"));
    expect([n2t.tokenName, n2t.tokenDecimals]).toEqual(["T2", 2]);
    const t2t = await ex.t2tPoolByNft(OTHER);
    expect(t2t.box.boxId).toBe(id("ee"));
    expect([t2t.xName, t2t.yName]).toEqual(["T2", "T3"]);
  });

  it("a pending successor not shaped like the pool is not used: the confirmed box is", async () => {
    const { ex } = explorer((p) => {
      if (p.startsWith("/api/v1/boxes/unspent/byTokenId/")) return { items: [pool("aa", [NFT, LP, TOK])] };
      if (p === MEMPOOL + addrA) return { items: [tx("t1", ["aa"], [box("bb", treeA, [LP, NFT, TOK])])] };
    });
    expect((await ex.poolByNft(NFT)).box.boxId).toBe(id("aa"));
  });
});
