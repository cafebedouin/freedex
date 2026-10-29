// The phone path without a page: the link encoding and the size guard, the address check, a real reduction through
// the Node binding of sigma-rust against ten mainnet headers (test/fixtures/headers.json, explorer
// /api/v1/blocks/headers on 2026-10-29), and the signer's wait loop against a hand-made explorer.
import { OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import { MockChain } from "@fleet-sdk/mock-chain";
import nodeLib from "ergo-lib-wasm-nodejs";
import { describe, expect, it } from "vitest";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import type { Explorer } from "../src/explorer";
import {
  base64url,
  ergopayLink,
  parsePhoneAddress,
  phoneSigner,
  QR_MAX_CHARS,
  reduceTransaction,
  sizeGuard,
  type ErgoLibModule,
  type Reduced,
} from "../src/ergopay";
import { FEE } from "../src/orders";
import { fakeErgoLib } from "./fake-ergolib";
import headers from "./fixtures/headers.json" with { type: "json" };

const lib = nodeLib as unknown as ErgoLibModule;

describe("the link", () => {
  it("is base64 with the URL-safe alphabet, padded", () => {
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8=");
    expect(base64url(new Uint8Array([0, 1, 2]))).toBe("AAEC");
    expect(base64url(new Uint8Array([]))).toBe("");
    expect(ergopayLink(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("ergopay:-_-_");
  });
  it("guards the QR size at 2,800 characters", () => {
    const fits = ergopayLink(new Uint8Array(2094)); // 8 + 2792: 698 groups of three bytes, four characters each
    expect(fits.length).toBe(2800);
    expect(sizeGuard(fits)).toBeUndefined();
    const over = ergopayLink(new Uint8Array(2100));
    expect(over.length).toBeGreaterThan(QR_MAX_CHARS);
    expect(sizeGuard(over)).toMatch(/2808 characters, above the 2800 .* fewer inputs/);
  });
});

describe("the phone's address", () => {
  it("takes a mainnet address and refuses the rest", () => {
    const ok = parsePhoneAddress(" 9gnBiuBAy4GgGEk1MZQ5f7aWWuQnyGHNVVF4bvhHKWvecWTNcfc ");
    expect(ok.address?.encode()).toBe("9gnBiuBAy4GgGEk1MZQ5f7aWWuQnyGHNVVF4bvhHKWvecWTNcfc");
    expect(parsePhoneAddress("3Wx7Z8FywaL4ofunDCV1NaTJX5CpjTubMrjpCkEhnNBAgJLGfRcD").why).toMatch(/mainnet/);
    expect(parsePhoneAddress("hello").why).toBe("not an Ergo address");
    expect(parsePhoneAddress("  ").why).toBe("no address given");
  });
});

describe("the reduction", () => {
  it("reduces a mock-chain transaction through the binding against mainnet headers, with Fleet's id", () => {
    const chain = new MockChain({ height: 1_900_000 });
    const me = chain.newParty("me");
    const you = chain.newParty("you");
    me.addBalance({ nanoergs: 10_000_000_000n, tokens: [{ tokenId: "a1".repeat(32), amount: 5n }] });
    const built = new TransactionBuilder(chain.height)
      .from(me.utxos.toArray())
      .to(new OutputBuilder(1_000_000_000n, you.address).addTokens({ tokenId: "a1".repeat(32), amount: 2n }))
      .sendChangeTo(me.address)
      .payFee(FEE)
      .build();
    const tx = built.toEIP12Object();
    const r = reduceTransaction(lib, tx, headers);
    expect(r.txId).toBe(built.id);
    expect(r.bytes.length).toBeGreaterThan(200);
    expect(r.link).toBe(`ergopay:${base64url(r.bytes)}`);
    expect(sizeGuard(r.link)).toBeUndefined();
    const back = lib.ReducedTransaction.sigma_parse_bytes(r.bytes);
    expect(back.unsigned_tx().id().to_str()).toBe(built.id);
    expect(chain.execute(tx, { signers: [me] })).toBe(true); // the same transaction is valid on the chain
  });
  it("wants ten headers", () => {
    const chain = new MockChain({ height: 1_900_000 });
    const me = chain.newParty("me");
    me.addBalance({ nanoergs: 10_000_000_000n });
    const tx = new TransactionBuilder(chain.height)
      .from(me.utxos.toArray())
      .to(new OutputBuilder(1_000_000_000n, me.address))
      .sendChangeTo(me.address)
      .payFee(FEE)
      .build()
      .toEIP12Object();
    expect(() => reduceTransaction(lib, tx, headers.slice(0, 3))).toThrow(/last 10 block headers, the explorer gave 3/);
  });
});

describe("the signer", () => {
  const TXID = "cd".repeat(32);
  const chain = new MockChain({ height: 1_900_000 });
  const me = chain.newParty("me");
  me.addBalance({ nanoergs: 3_000_000_000n, tokens: [{ tokenId: "b2".repeat(32), amount: 7n }] });
  me.addBalance({ nanoergs: 2_000_000_000n });
  const boxes = me.utxos.toArray();

  function world(seenAfter: number, reducedBytes = 500, realSleep = false) {
    let polls = 0;
    const calls = { seen: [] as [string, string][] };
    const explorer = {
      height: async () => 1_905_000,
      headers: async (n: number) => headers.slice(0, n),
      unspentByAddress: async () => boxes,
      seen: async (txId: string, address: string) => {
        calls.seen.push([txId, address]);
        return ++polls > seenAfter;
      },
    } as unknown as Explorer;
    const shown: Reduced[] = [];
    const status: string[] = [];
    let hidden = 0;
    let cancel: (() => void) | undefined;
    let clock = 0;
    const signer = phoneSigner(
      me.address,
      explorer,
      {
        show: (r, c) => {
          shown.push(r);
          cancel = c;
        },
        status: (t) => status.push(t),
        hide: () => hidden++,
      },
      {
        loadLib: async () => fakeErgoLib(TXID, new Uint8Array(reducedBytes)).lib,
        pollMs: 10_000,
        timeoutMs: 60_000,
        sleep: realSleep ? (ms) => new Promise((r) => setTimeout(r, ms / 10_000)) : async (ms) => void (clock += ms),
        now: () => clock,
      },
    );
    const tx = {
      inputs: boxes.map((b) => ({ ...b, value: b.value.toString(), assets: [], extension: {} })),
      dataInputs: [],
      outputs: [],
    } as unknown as EIP12UnsignedTransaction;
    return { signer, tx, shown, status, cancel: () => cancel?.(), hidden: () => hidden, calls };
  }

  it("reads boxes and balances from the explorer, as EIP-12 boxes", async () => {
    const { signer } = world(0);
    expect(signer.kind).toBe("ergopay");
    expect(signer.usedAddresses).toEqual([me.address.encode()]);
    const u = await signer.utxos();
    expect(u.length).toBe(2);
    expect(typeof u[0].value).toBe("string");
    expect(await signer.balance("ERG")).toBe(5_000_000_000n);
    expect(await signer.balance("b2".repeat(32))).toBe(7n);
    expect(await signer.height()).toBe(1_905_000);
  });

  it("shows the code, polls until the explorer sees the id, then leaves those inputs out", async () => {
    const w = world(2);
    const id = await w.signer.sign(w.tx);
    expect(id).toBe(TXID);
    expect(w.shown.length).toBe(1);
    expect(w.shown[0].link).toBe(`ergopay:${base64url(new Uint8Array(500))}`);
    expect(w.calls.seen).toEqual([
      [TXID, me.address.encode()],
      [TXID, me.address.encode()],
      [TXID, me.address.encode()],
    ]);
    expect(w.status).toEqual(["waiting for the wallet, 1 min left", "waiting for the wallet, 1 min left"]);
    expect(w.hidden()).toBe(1);
    expect(await w.signer.utxos()).toEqual([]); // spent until the explorer stops listing them, or 15 minutes
  });

  it("gives up after the timeout, and on cancel", async () => {
    const w = world(99);
    await expect(w.signer.sign(w.tx)).rejects.toThrow(/no transaction cdcdcdcd… seen in 1 minutes/);
    expect(w.hidden()).toBe(1);
    const c = world(99, 500, true); // the clock stands still; the wait is real, 1 ms a poll
    const p = c.signer.sign(c.tx);
    await new Promise((r) => setTimeout(r, 5));
    c.cancel();
    await expect(p).rejects.toThrow(/cancelled/);
  });

  it("refuses a transaction too large for a code before showing anything", async () => {
    const w = world(0, 2200);
    await expect(w.signer.sign(w.tx)).rejects.toThrow(/2944 characters, above the 2800/);
    expect(w.shown).toEqual([]);
    expect(w.hidden()).toBe(0);
  });
});
