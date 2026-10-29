// Reads from a public explorer API. No keys, no writes except transaction submission, which the wallet does.
import type { Box } from "@fleet-sdk/common";

export const DEFAULT_EXPLORER = "https://api.ergoplatform.com";
/** Tried in order when the one before fails or times out. Both serve the same /api/v1 and allow cross-origin reads. */
export const EXPLORERS = [DEFAULT_EXPLORER, "https://api.ergo.aap.cornell.edu"];
export const REQUEST_TIMEOUT_MS = 15_000;
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

/** SHA-256 of the Machina E2T limit-order ErgoTree template (scripts/template-hash.mjs, 2026-10-29). */
export const E2T_LIMIT_TEMPLATE_SHA256 = "03ef002b73a894198c7c9a4332ba28ca000dc6c40cb801f0c719940d9a6a8f6b";

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
  additionalRegisters: Record<string, ExplorerRegister>;
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

/** SHA-256 of the EIP-31 Babel template, the same for every token (pinned by test/hashes.test.ts). */
export const BABEL_TEMPLATE_SHA256 = "4e83fa68ef3ed9794bbab5d8799998a9e09fb10a0afe8d1bf928936dfd11c465";

/** SHA-256 of the ErgoDEX v1 T2T pool template (pinned by test/hashes.test.ts). */
export const T2T_POOL_TEMPLATE_SHA256 = "3c09deff3b5f49329149d18e02aab675ef6957bf6559a5c7dba817fee883fb3e";

/** SHA-256 of the ErgoDEX v1 N2T pool template (pinned to the tree by test/hashes.test.ts). */
export const POOL_TEMPLATE_SHA256 = "2dcc7830afe8f355b945850c60ff2b41fdb3e8ade07fde0a7c8a3ec498e8c3f6";

export interface TokenInfo {
  id: string;
  name: string;
  decimals: number;
}

export class Explorer {
  /** The base that answered last; starts as the one given. */
  base: string;
  readonly bases: string[];
  /** Called when a different base answered than last time (the page shows a line when it is not the first). */
  onBaseChange?: (base: string) => void;
  #cache = new Map<string, { at: number; value: unknown }>();
  constructor(base?: string, fallbacks: string[] = EXPLORERS) {
    this.base = base ?? fallbacks[0];
    this.bases = [this.base, ...fallbacks.filter((b) => b !== this.base)];
  }

  /** The same request against each base in turn, each with a timeout; the first success wins and becomes `base`. */
  async #fetchAny(path: string, init?: RequestInit): Promise<Response> {
    let last: unknown;
    for (const base of this.bases) {
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
        return res;
      } catch (e) {
        last = e;
      }
    }
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

  /** The current box of one pool, by its NFT: fetched fresh right before a swap is built. */
  async poolByNft(nft: string): Promise<PoolEntry> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/byTokenId/${nft}?limit=5`);
    const b = r.items.find((x) => x.assets.length === 3 && x.assets[0].tokenId === nft);
    if (!b) throw new Error("pool box not found");
    return { box: toFleetBox(b), tokenName: b.assets[2].name ?? "", tokenDecimals: b.assets[2].decimals ?? 0 };
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

  async t2tPoolByNft(nft: string): Promise<T2TPoolEntry> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/byTokenId/${nft}?limit=5`);
    const b = r.items.find((x) => x.assets.length === 4 && x.assets[0].tokenId === nft);
    if (!b) throw new Error("pool box not found");
    return t2tEntry(b);
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
  for (const [k, v] of Object.entries(b.additionalRegisters)) registers[k] = v.serializedValue;
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
