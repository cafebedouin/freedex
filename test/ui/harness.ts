// The page in happy-dom: index.html loaded into the document, `fetch` answered from a world of mock-chain boxes in
// the explorer's JSON shape, an EIP-12 wallet stubbed on `ergoConnector`, and the real src/main.ts booted on top.
import type { Box } from "@fleet-sdk/common";
import { ErgoAddress, ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import type { MockChain, MockChainParty } from "@fleet-sdk/mock-chain";
import { vi } from "vitest";
import { EXPLORERS } from "../../src/explorer";
import HTML from "../../index.html?raw";

export interface TokenMeta {
  name: string;
  decimals: number;
}

export interface World {
  height: number;
  boxes: Box<bigint>[];
  tokens: Record<string, TokenMeta>;
  /** the first explorer base refuses every request, so the page falls back to the second */
  failFirstBase?: boolean;
  /** node JSON of transactions submitted through the explorer's mempool endpoint (the keyless upkeep) */
  submitted: string[];
  /** ids the explorer reports in the mempool (by address) or in a block, for the phone path's wait */
  mempool?: string[];
  confirmed?: string[];
}

const templateHash = (tree: string) => hex.encode(sha256(new ErgoTree(tree).template));
const raw = (JSON as unknown as { rawJSON: (s: string) => unknown }).rawJSON;
const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? raw(x.toString()) : x));

/** A mock-chain box in the explorer's JSON shape (amounts as exact integers, registers wrapped, token metadata). */
export function explorerBox(b: Box<bigint>, tokens: Record<string, TokenMeta>) {
  const additionalRegisters: Record<string, { serializedValue: string }> = {};
  for (const [k, v] of Object.entries(b.additionalRegisters))
    if (v) additionalRegisters[k] = { serializedValue: v as string };
  return {
    boxId: b.boxId,
    transactionId: b.transactionId,
    index: b.index,
    value: b.value,
    ergoTree: b.ergoTree,
    creationHeight: b.creationHeight,
    assets: b.assets.map((a) => ({
      tokenId: a.tokenId,
      amount: a.amount,
      name: tokens[a.tokenId]?.name,
      decimals: tokens[a.tokenId]?.decimals,
    })),
    additionalRegisters,
  };
}

/** Replaces the global `fetch` with one that answers the explorer's endpoints from the world. */
export function installFetch(w: World) {
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (w.failFirstBase && url.origin === EXPLORERS[0]) throw new TypeError("fetch failed");
    const path = url.pathname;
    let status = 200;
    let body: unknown = {};
    if (path === "/api/v1/networkState") body = { height: w.height };
    else if (path.startsWith("/api/v1/tokens/")) {
      const id = path.slice("/api/v1/tokens/".length);
      const t = w.tokens[id];
      if (t) body = { id, ...t };
      else status = 404;
    } else if (path === "/api/v1/boxes/unspent/search") {
      const { ergoTreeTemplateHash } = JSON.parse(String(init?.body)) as { ergoTreeTemplateHash: string };
      const items = w.boxes
        .filter((b) => templateHash(b.ergoTree) === ergoTreeTemplateHash)
        .map((b) => explorerBox(b, w.tokens));
      body = { items, total: items.length };
    } else if (path.startsWith("/api/v1/boxes/unspent/byTokenId/")) {
      const id = path.slice("/api/v1/boxes/unspent/byTokenId/".length);
      const items = w.boxes.filter((b) => b.assets.some((a) => a.tokenId === id)).map((b) => explorerBox(b, w.tokens));
      body = { items, total: items.length };
    } else if (path === "/api/v1/blocks/headers") {
      const n = Number(url.searchParams.get("limit") ?? 10);
      const items = Array.from({ length: n }, (_, i) => ({
        height: w.height - i,
        id: String(w.height - i).padStart(64, "0"),
      }));
      body = { items, total: w.height };
    } else if (path.startsWith("/api/v1/boxes/unspent/byAddress/")) {
      const tree = ErgoAddress.fromBase58(path.slice("/api/v1/boxes/unspent/byAddress/".length)).ergoTree;
      const items = w.boxes.filter((b) => b.ergoTree === tree).map((b) => explorerBox(b, w.tokens));
      body = { items, total: items.length };
    } else if (path.startsWith("/api/v1/transactions/")) {
      const id = path.slice("/api/v1/transactions/".length);
      if (w.confirmed?.includes(id)) body = { id };
      else status = 404;
    } else if (path.startsWith("/api/v1/mempool/transactions/byAddress/")) {
      const items = (w.mempool ?? []).map((id) => ({ id }));
      body = { items, total: items.length };
    } else if (path === "/api/v1/mempool/transactions/submit") {
      const json = String(init?.body);
      w.submitted.push(json);
      body = (JSON.parse(json) as { id: string }).id;
    } else status = 404;
    const text = stringify(body);
    return { status, ok: status < 400, text: async () => text } as Response;
  });
  globalThis.fetch = f as unknown as typeof fetch;
  return f;
}

export interface WalletStub {
  sign_tx: ReturnType<typeof vi.fn>;
  submit_tx: ReturnType<typeof vi.fn>;
}

/** An EIP-12 connector named "nautilus" backed by a mock-chain party: balances and boxes from the chain, signing stubbed. */
export function installWallet(chain: MockChain, party: MockChainParty): WalletStub {
  const addr = party.address.encode();
  const api = {
    get_change_address: async () => addr,
    get_used_addresses: async () => [addr],
    get_unused_addresses: async () => [],
    get_balance: async (id = "ERG") =>
      (id === "ERG"
        ? party.balance.nanoergs
        : (party.balance.tokens.find((t) => t.tokenId === id)?.amount ?? 0n)
      ).toString(),
    get_utxos: async () =>
      party.utxos.toArray().map((b) => ({
        ...b,
        value: b.value.toString(),
        assets: b.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
      })),
    get_current_height: async () => chain.height,
    sign_tx: vi.fn(async (tx: unknown) => tx),
    submit_tx: vi.fn(async () => "ab".repeat(32)),
  };
  (globalThis as { ergoConnector?: unknown }).ergoConnector = {
    nautilus: {
      connect: async () => true,
      disconnect: async () => true,
      isConnected: async () => true,
      getContext: async () => api,
    },
  };
  return api;
}

export function noWallet() {
  delete (globalThis as { ergoConnector?: unknown }).ergoConnector;
}

/** Writes index.html into the document (without its module script) and boots src/main.ts afresh. */
export async function loadPage() {
  document.open();
  document.write(HTML.replace(/<script[^>]*><\/script>/, ""));
  document.close();
  localStorage.clear();
  vi.resetModules();
  await import("../../src/main.ts");
  await settle();
}

/** Lets the page's fetches and renders run. */
export const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

export const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const text = (id: string) => (el(id).textContent ?? "").replace(/\s+/g, " ").trim();

export function type(id: string, value: string) {
  const input = el<HTMLInputElement>(id);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function choose(id: string, value: string) {
  const sel = el<HTMLSelectElement>(id);
  sel.value = value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

export function tab(name: string) {
  document.querySelector<HTMLButtonElement>(`nav [data-tab="${name}"]`)!.click();
}

/** Clicks "connect nautilus" in the header and waits for the page to re-render. */
export async function connect() {
  const b = [...el("wallet").querySelectorAll("button")].find((x) => x.textContent === "connect nautilus");
  if (!b) throw new Error("no connect button");
  b.click();
  await settle();
}

/** The dl rows of a definition list as label -> value. */
export function rows(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dl = el(id);
  const dts = dl.querySelectorAll("dt"),
    dds = dl.querySelectorAll("dd");
  dts.forEach((dt, i) => (out[dt.textContent ?? ""] = dds[i]?.textContent ?? ""));
  return out;
}

/** The text of one column of a table's body rows. */
export function column(table: HTMLTableElement, index: number): string[] {
  return [...table.querySelectorAll("tbody tr")].map((tr) =>
    (tr.children[index].textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}
