// Reads from a public explorer API. No keys, no writes except transaction submission, which the wallet does.
import type { Box } from "@fleet-sdk/common";

export const DEFAULT_EXPLORER = "https://api.ergoplatform.com";

/** SHA-256 of the Machina E2T limit-order ErgoTree template (scripts/template-hash.mjs, 2026-10-29). */
export const E2T_LIMIT_TEMPLATE_SHA256 =
  "03ef002b73a894198c7c9a4332ba28ca000dc6c40cb801f0c719940d9a6a8f6b";

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

/** SHA-256 of the ErgoDEX v1 N2T pool template (scripts/pools.ts, 2026-10-29). */
export const POOL_TEMPLATE_SHA256 = "2dcc7830afe8f355b945850c60ff2b41fdb3e8ade07fde0a7c8a3ec498e8c3f6";

export interface TokenInfo {
  id: string;
  name: string;
  decimals: number;
}

export class Explorer {
  readonly base: string;
  constructor(base: string = DEFAULT_EXPLORER) {
    this.base = base;
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
    const r = await this.#json<{ items: ExplorerBox[]; total: number }>(
      `/api/v1/boxes/unspent/search?limit=${limit}&sortDirection=desc`,
      { method: "POST", body: JSON.stringify({ ergoTreeTemplateHash: E2T_LIMIT_TEMPLATE_SHA256 }) },
    );
    return r.items.map(toFleetBox);
  }

  /** Every N2T pool box (NFT, LP token, token), with the token's name and decimals as the explorer carries them. */
  async pools(limit = 500): Promise<PoolEntry[]> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/search?limit=${limit}`, {
      method: "POST",
      body: JSON.stringify({ ergoTreeTemplateHash: POOL_TEMPLATE_SHA256 }),
    });
    return r.items
      .filter((b) => b.assets.length === 3)
      .map((b) => ({ box: toFleetBox(b), tokenName: b.assets[2].name ?? "", tokenDecimals: b.assets[2].decimals ?? 0 }));
  }

  /** The current box of one pool, by its NFT: fetched fresh right before a swap is built. */
  async poolByNft(nft: string): Promise<PoolEntry> {
    const r = await this.#json<{ items: ExplorerBox[] }>(`/api/v1/boxes/unspent/byTokenId/${nft}?limit=5`);
    const b = r.items.find((x) => x.assets.length === 3 && x.assets[0].tokenId === nft);
    if (!b) throw new Error("pool box not found");
    return { box: toFleetBox(b), tokenName: b.assets[2].name ?? "", tokenDecimals: b.assets[2].decimals ?? 0 };
  }

  txUrl(txId: string): string {
    const host = this.base.replace(/^https?:\/\/api\./, "https://");
    return `${host}/en/transactions/${txId}`;
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
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
