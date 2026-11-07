// Reads from a public explorer API. No keys, no writes except transaction submission, which the wallet does.
import type { Box } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import { hashOf } from "./registry.ts";

export const DEFAULT_EXPLORER = "https://api.ergoplatform.com";
/** Tried in order when the one before fails or times out. Both serve the same /api/v1 and allow cross-origin reads. */
export const EXPLORERS = [DEFAULT_EXPLORER, "https://api.ergo.aap.cornell.edu"];
export const REQUEST_TIMEOUT_MS = 15_000;
/** Waits before each retry of a failed request on the same backend (so four tries a backend) before the next backend is tried. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000];
/** Pool and order listings are reused for this long across tabs and the upkeep runner. */
export const CACHE_MS = 30_000;
const STORAGE_KEY = "freedex.explorer";

/** The visitor's chosen explorer, if they set one on the page; stored in this browser only. */
export function storedExplorer(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
export function storeExplorer(base: string | undefined) {
  try {
    if (base) localStorage.setItem(STORAGE_KEY, base);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no storage */
  }
}

/** SHA-256 of the Machina E2T limit-order ErgoTree template (src/registry.json). */
export const E2T_LIMIT_TEMPLATE_SHA256 = hashOf("machina-e2t-limit-order");

interface ExplorerRegister {
  serializedValue: string;
  sigmaType?: string;
  renderedValue?: string;
}

interface ExplorerBox {
  boxId: string;
  transactionId: string;
  index: number;
  value: number | string | bigint;
  ergoTree: string;
  creationHeight: number;
  assets: { tokenId: string; amount: number | string | bigint; name?: string; decimals?: number }[];
  /** `{serializedValue, …}`, confirmed and mempool alike (seen 2026-11-06); the OpenAPI schema says a bare hex string for mempool boxes, so that is read too */
  additionalRegisters: Record<string, ExplorerRegister | string>;
}

/** A transaction in the explorer's mempool listing: what it spends and the boxes it creates. */
export interface MempoolTx {
  id: string;
  inputs?: { boxId: string }[];
  outputs?: ExplorerBox[];
}

/** How many unconfirmed transactions in a row `latestByToken` follows before it stops. */
export const MAX_CHAIN = 25;

/**
 * The box that spends `current` in the mempool and carries `tokenId` on, if a transaction in `txs` spends it.
 * A singleton token (a bank's or a pool's NFT) leaves through exactly one output.
 */
export function nextInChain(current: string, tokenId: string, txs: MempoolTx[]): Box<bigint> | undefined {
  const tx = txs.find((t) => (t.inputs ?? []).some((i) => i.boxId === current));
  const out = tx?.outputs?.find((o) => o.assets.some((a) => a.tokenId === tokenId));
  return out ? toFleetBox(out) : undefined;
}

/**
 * An address's spendable boxes once the mempool is counted: the confirmed ones its pending transactions have not
 * spent, plus the outputs those transactions pay back to the same script that nothing in the mempool spends yet.
 */
export function chainUnspent(confirmed: Box<bigint>[], txs: MempoolTx[], ergoTree: string): Box<bigint>[] {
  const spent = new Set(txs.flatMap((t) => (t.inputs ?? []).map((i) => i.boxId)));
  const pending = txs.flatMap((t) => (t.outputs ?? []).filter((o) => o.ergoTree === ergoTree).map(toFleetBox));
  const seen = new Set<string>();
  return [...confirmed, ...pending].filter((b) => {
    if (spent.has(b.boxId) || seen.has(b.boxId)) return false;
    seen.add(b.boxId);
    return true;
  });
}

export interface PoolEntry {
  box: Box<bigint>;
  tokenName: string;
  tokenDecimals: number;
}

export interface T2TPoolEntry {
  box: Box<bigint>;
  xName: string;
  xDecimals: number;
  yName: string;
  yDecimals: number;
}

/** SHA-256 of the EIP-31 Babel template, the same for every token (src/registry.json). */
export const BABEL_TEMPLATE_SHA256 = hashOf("eip31-babel");

/** SHA-256 of the ErgoDEX v1 T2T pool template (src/registry.json). */
export const T2T_POOL_TEMPLATE_SHA256 = hashOf("ergodex-t2t-pool");

/** SHA-256 of the ErgoDEX v1 N2T pool template (src/registry.json). */
export const POOL_TEMPLATE_SHA256 = hashOf("ergodex-n2t-pool");

export interface TokenInfo {
  id: string;
  name: string;
  decimals: number;
}

/** What the page shows while a request is being retried, after every backend failed, or once one answered again. */
export interface ExplorerStatus {
  state: "retrying" | "failed" | "ok";
  base: string;
  /** the try that just failed (1 to RETRY_DELAYS_MS.length + 1) */
  attempt: number;
  path: string;
  error?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Explorer {
  /** The base that answered last; starts as the one given. */
  base: string;
  readonly bases: string[];
  /** Called when a different base answered than last time (the page shows a line when it is not the first). */
  onBaseChange?: (base: string) => void;
  /** Called on every failed try (retrying), when every backend has failed (failed), and on the first success after a failure (ok). */
  onStatus?: (status: ExplorerStatus) => void;
  /** The wait between retries; tests replace it. */
  sleep: (ms: number) => Promise<void> = defaultSleep;
  #cache = new Map<string, { at: number; value: unknown }>();
  #degraded = false;
  constructor(base?: string, fallbacks: string[] = EXPLORERS) {
    this.base = base ?? fallbacks[0];
    this.bases = [this.base, ...fallbacks.filter((b) => b !== this.base)];
  }

  /**
   * The same request against each base in turn, each try with a timeout. A network error, a timeout, a 5xx or a
   * 429 is retried on the same backend after RETRY_DELAYS_MS (1 s, 2 s, 4 s) before the next backend is tried; any
   * other answer is returned as is. The first success wins and becomes `base`.
   */
  async #fetchAny(path: string, init?: RequestInit): Promise<Response> {
    let last: unknown;
    for (const base of this.bases) {
      for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
        try {
          const res = await fetch(base + path, {
            ...init,
            headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (res.status >= 500 || res.status === 429) throw new Error(`explorer ${res.status} on ${path}`);
          if (this.base !== base) {
            this.base = base;
            this.onBaseChange?.(base);
          }
          if (this.#degraded) {
            this.#degraded = false;
            this.onStatus?.({ state: "ok", base, attempt, path });
          }
          return res;
        } catch (e) {
          last = e;
          const error = e instanceof Error ? e.message : String(e);
          this.#degraded = true;
          if (attempt <= RETRY_DELAYS_MS.length) {
            this.onStatus?.({ state: "retrying", base, attempt, path, error });
            await this.sleep(RETRY_DELAYS_MS[attempt - 1]);
          }
        }
      }
    }
    const error = last instanceof Error ? last.message : String(last);
    this.onStatus?.({ state: "failed", base: this.base, attempt: RETRY_DELAYS_MS.length + 1, path, error });
    throw last instanceof Error ? last : new Error(String(last));
  }

  async #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    this.#cache.set(key, { at: Date.now(), value });
    return value;
  }

  async height(): Promise<number> {
    const r = await this.#json<{ height: number }>("/api/v1/networkState");
    return r.height;
  }

  async token(id: string): Promise<TokenInfo> {
    const r = await this.#json<{ id: string; name?: string; decimals?: number }>(`/api/v1/tokens/${id}`);
    return { id: r.id, name: r.name ?? "", decimals: r.decimals ?? 0 };
  }

  /** Every unspent box under the E2T limit-order template, newest first, up to `limit`. */
  async limitOrders(limit = 100): Promise<Box<bigint>[]> {
    return this.#cached(`orders:${limit}`, () => this.#limitOrders(limit));
  }
  async #limitOrders(limit: number): Promise<Box<bigint>[]> {
    const r = await this.#json<{ items: ExplorerBox[]; total: number }>(
      `/api/v1/boxes/unspent/search?limit=${limit}&sortDirection=desc`,
      { method: "POST", body: JSON.stringify({ ergoTreeTemplateHash: E2T_LIMIT_TEMPLATE_SHA256 }) },
    );
    return r.items.map(toFleetBox);
  }

  /** Every N2T pool box (NFT, LP token, token), with the token's name and decimals as the explorer carries them. */
  async pools(limit = 500): Promise<PoolEntry[]> {
    return this.#cached(`pools:${limit}`, () => this.#pools(limit));
  }
  async #pools(limit: number): Promise<PoolEntry[]> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/search?limit=${limit}`, {
      method: "POST",
      body: JSON.stringify({ ergoTreeTemplateHash: POOL_TEMPLATE_SHA256 }),
    });
    return r.items
      .filter((b) => b.assets.length === 3)
      .map((b) => ({
        box: toFleetBox(b),
        tokenName: b.assets[2].name ?? "",
        tokenDecimals: b.assets[2].decimals ?? 0,
      }));
  }

  /** The current box of one pool, by its NFT, mempool included: fetched fresh right before a swap is built. */
  async poolByNft(nft: string): Promise<PoolEntry> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/byTokenId/${nft}?limit=5`);
    const b = r.items.find((x) => x.assets.length === 3 && x.assets[0].tokenId === nft);
    if (!b) throw new Error("pool box not found");
    const box = await this.#poolChain(toFleetBox(b), nft, 3);
    return { box, tokenName: b.assets[2].name ?? "", tokenDecimals: b.assets[2].decimals ?? 0 };
  }

  /**
   * A pool's newest box, chained off the mempool (`#follow`) so a swap is built after a pending swap on the same
   * pool rather than against it. A successor that is not shaped like the pool (NFT first, `assets` tokens) is not
   * used: the confirmed box is.
   */
  async #poolChain(confirmed: Box<bigint>, nft: string, assets: number): Promise<Box<bigint>> {
    const latest = await this.#follow(confirmed, nft);
    return latest.assets.length === assets && latest.assets[0].tokenId === nft ? latest : confirmed;
  }

  /** Every token-to-token pool box (NFT, LP token, token X, token Y). */
  async t2tPools(limit = 500): Promise<T2TPoolEntry[]> {
    return this.#cached(`t2t:${limit}`, () => this.#t2tPools(limit));
  }
  async #t2tPools(limit: number): Promise<T2TPoolEntry[]> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/search?limit=${limit}`, {
      method: "POST",
      body: JSON.stringify({ ergoTreeTemplateHash: T2T_POOL_TEMPLATE_SHA256 }),
    });
    return r.items.filter((b) => b.assets.length === 4).map(t2tEntry);
  }

  /** The same for a token-to-token pool. */
  async t2tPoolByNft(nft: string): Promise<T2TPoolEntry> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/byTokenId/${nft}?limit=5`);
    const b = r.items.find((x) => x.assets.length === 4 && x.assets[0].tokenId === nft);
    if (!b) throw new Error("pool box not found");
    return { ...t2tEntry(b), box: await this.#poolChain(toFleetBox(b), nft, 4) };
  }

  /** Every unspent EIP-31 Babel box, any token. */
  async babelBoxes(limit = 500): Promise<Box<bigint>[]> {
    return this.#cached(`babel:${limit}`, () => this.#babelBoxes(limit));
  }
  async #babelBoxes(limit: number): Promise<Box<bigint>[]> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/search?limit=${limit}`, {
      method: "POST",
      body: JSON.stringify({ ergoTreeTemplateHash: BABEL_TEMPLATE_SHA256 }),
    });
    return r.items.map(toFleetBox);
  }

  /** Unspent boxes under any ErgoTree template, by its SHA-256. */
  async byTemplate(templateSha256: string, limit = 200): Promise<Box<bigint>[]> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/search?limit=${limit}`, {
      method: "POST",
      body: JSON.stringify({ ergoTreeTemplateHash: templateSha256 }),
    });
    return r.items.map(toFleetBox);
  }

  /** Unspent boxes holding a token (a singleton's current box, for instance). */
  async byToken(tokenId: string, limit = 5): Promise<Box<bigint>[]> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/byTokenId/${tokenId}?limit=${limit}`);
    return r.items.map(toFleetBox);
  }

  /** Unspent boxes at an address, newest first, as the phone signer's inputs. Not cached. Confirmed state only. */
  async unspentByAddress(address: string, limit = 100): Promise<Box<bigint>[]> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/byAddress/${address}?limit=${limit}`);
    return r.items.map(toFleetBox);
  }

  /** Unconfirmed transactions that spend from or pay to an address. Not cached. */
  async mempoolByAddress(address: string, limit = 100): Promise<MempoolTx[]> {
    const r = await this.#json<{ items?: MempoolTx[] }>(
      `/api/v1/mempool/transactions/byAddress/${address}?limit=${limit}`,
    );
    return r.items ?? [];
  }

  /**
   * An address's boxes with its pending transactions counted (`chainUnspent`), so a build does not reuse a box the
   * mempool already spends and can spend change that has not confirmed. A failed mempool read gives the confirmed set.
   */
  async unspentByAddressChained(address: string, limit = 100): Promise<Box<bigint>[]> {
    const confirmed = await this.unspentByAddress(address, limit);
    let txs: MempoolTx[];
    try {
      txs = await this.mempoolByAddress(address);
    } catch {
      return confirmed;
    }
    return chainUnspent(confirmed, txs, ErgoAddress.fromBase58(address).ergoTree);
  }

  /**
   * The newest box of a singleton token, chained off the mempool the way tokenjay.app does: start from the
   * confirmed box and follow each unconfirmed transaction that spends it, up to MAX_CHAIN deep. A shared box like
   * the SigmaUSD bank is spent every few blocks; building on the confirmed box while a spend of it sits in the
   * mempool is what the node refuses as a double spend. The script may change along the way (an oracle pool's
   * epoch boxes), so each step asks the mempool by the current box's address. A failed mempool read stops the walk
   * where it is.
   */
  async latestByToken(tokenId: string): Promise<Box<bigint>> {
    const [confirmed] = await this.byToken(tokenId, 1);
    if (!confirmed) throw new Error(`no unspent box holds ${tokenId.slice(0, 8)}…`);
    return this.#follow(confirmed, tokenId);
  }

  /** From a confirmed box, each unconfirmed spend that carries `tokenId` on, up to MAX_CHAIN deep (see `latestByToken`). */
  async #follow(confirmed: Box<bigint>, tokenId: string): Promise<Box<bigint>> {
    const byAddress = new Map<string, MempoolTx[]>();
    let current = confirmed;
    for (let depth = 0; depth < MAX_CHAIN; depth++) {
      const address = ErgoAddress.fromErgoTree(current.ergoTree).encode();
      let txs = byAddress.get(address);
      if (!txs) {
        try {
          txs = await this.mempoolByAddress(address);
        } catch {
          return current;
        }
        byAddress.set(address, txs);
      }
      const next = nextInChain(current.boxId, tokenId, txs);
      if (!next) return current;
      current = next;
    }
    return current;
  }

  /** The last `n` block headers, newest first, as the explorer serves them; sigma-rust's binding parses them as is. */
  async headers(n: number): Promise<unknown[]> {
    const r = await this.#json<{ items: unknown[] }>(`/api/v1/blocks/headers?limit=${n}`);
    return r.items;
  }

  /**
   * Whether a transaction is in a block or in the mempool, by id. The mempool is only listed by address, so the
   * address that signed is asked. A failing request counts as not seen: the caller polls.
   */
  async seen(txId: string, address: string): Promise<boolean> {
    try {
      const res = await this.#fetchAny(`/api/v1/transactions/${txId}`);
      if (res.ok) return true;
    } catch {
      /* not seen yet */
    }
    try {
      const r = await this.#json<{ items: { id: string }[] }>(`/api/v1/mempool/transactions/byAddress/${address}`);
      return r.items.some((t) => t.id === txId);
    } catch {
      return false;
    }
  }

  /** Forget the listings, after a transaction of ours changes them. */
  invalidate() {
    this.#cache.clear();
  }

  /** Submit a transaction in node JSON form through the explorer's mempool endpoint; returns the id. */
  async submit(txJson: string): Promise<string> {
    const res = await this.#fetchAny(`/api/v1/mempool/transactions/submit`, { method: "POST", body: txJson });
    const text = await res.text();
    if (!res.ok) throw new Error(`submit ${res.status}: ${text.slice(0, 200)}`);
    try {
      const j = JSON.parse(text) as { id?: string } | string;
      return typeof j === "string" ? j : (j.id ?? text);
    } catch {
      return text.replace(/"/g, "");
    }
  }

  txUrl(txId: string): string {
    const host = this.base.replace(/^https?:\/\/api\./, "https://");
    return `${host}/en/transactions/${txId}`;
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.#fetchAny(path, init);
    if (!res.ok) throw new Error(`explorer ${res.status} on ${path}`);
    return parseExact(await res.text()) as T;
  }
}

/**
 * JSON with "value" and "amount" fields read as exact integers. Token amounts reach 2^63 (every ErgoDEX pool's LP
 * token), past what a JavaScript number holds; a rounded amount changes the box bytes, so its id no longer matches
 * and Fleet refuses it as an input. The reviver's third argument (the source text) exists in Node 21+ and current
 * browsers; where it does not, an unsafe integer is refused rather than rounded.
 */
export function parseExact(text: string): unknown {
  return JSON.parse(text, function (key: string, value: unknown, ctx?: { source?: string }) {
    if ((key === "value" || key === "amount") && typeof value === "number" && Number.isInteger(value)) {
      if (ctx?.source) return BigInt(ctx.source);
      if (!Number.isSafeInteger(value)) throw new Error(`integer ${key} too large for this browser's JSON parser`);
      return BigInt(value);
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

function t2tEntry(b: ExplorerBox): T2TPoolEntry {
  return {
    box: toFleetBox(b),
    xName: b.assets[2].name ?? "",
    xDecimals: b.assets[2].decimals ?? 0,
    yName: b.assets[3].name ?? "",
    yDecimals: b.assets[3].decimals ?? 0,
  };
}

export function toFleetBox(b: ExplorerBox): Box<bigint> {
  const registers: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.additionalRegisters))
    registers[k] = typeof v === "string" ? v : v.serializedValue;
  return {
    boxId: b.boxId,
    transactionId: b.transactionId,
    index: b.index,
    value: BigInt(b.value),
    ergoTree: b.ergoTree,
    creationHeight: b.creationHeight,
    assets: b.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
    additionalRegisters: registers,
  };
}
