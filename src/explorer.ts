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
  value: number | string;
  ergoTree: string;
  creationHeight: number;
  assets: { tokenId: string; amount: number | string }[];
  additionalRegisters: Record<string, ExplorerRegister>;
}

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
    return (await res.json()) as T;
  }
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
