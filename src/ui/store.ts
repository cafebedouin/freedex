// The state the tabs share (wallet, explorer, tokens, pool listings, the bank, the Swap tab's assets) with a small
// subscription so a tab re-renders when the wallet or a listing changes. No DOM except the log line.
import type { SigmaUSDBank } from "@fleet-sdk/ageusd-plugin";
import type { Box } from "@fleet-sdk/common";
import { describeT2TPool, t2tSides } from "../protocols/ergodex/amm";
import { describeBabel } from "../protocols/babel/babel";
import { loadBank } from "../protocols/sigmausd/bank";
import type { Explorer, ExplorerStatus, PoolEntry, T2TPoolEntry, TokenInfo } from "../explorer";
import tokenlist from "../tokenlist.json" with { type: "json" };
import { describe as describeOrder } from "../protocols/machina/orders";
import { ERG_DECIMALS } from "../units";
import type { Wallet } from "../wallet";
import { err, log } from "./dom";

export const ERG = "ERG";
export const OTHER = "__other__";

export type Topic = "wallet" | "pools" | "bank" | "orders" | "explorer";

export interface State {
  wallet?: Wallet;
  pools: PoolEntry[];
  t2tPools: T2TPoolEntry[];
  /** open Machina limit orders and EIP-31 Babel boxes, as the explorer listed them */
  orderBoxes: Box<bigint>[];
  babelBoxes: Box<bigint>[];
  bank?: SigmaUSDBank;
  /** the Swap tab's assets */
  fromId: string;
  toId: string;
  /** why the pool listing is empty, when a load failed; cleared by a load that succeeds */
  poolsError?: string;
}

export class Store {
  readonly explorer: Explorer;
  readonly tokens = new Map<string, TokenInfo>();
  readonly state: State = { pools: [], t2tPools: [], orderBoxes: [], babelBoxes: [], fromId: ERG, toId: "" };
  #subs = new Map<Topic, Set<() => void>>();

  /** The explorer's last reported state: a retry in progress, every backend failed, or answering again. */
  explorerStatus?: ExplorerStatus;

  constructor(explorer: Explorer) {
    this.explorer = explorer;
    explorer.onStatus = (s) => {
      this.explorerStatus = s;
      this.notify("explorer");
    };
  }

  /** One line for a listing that is loading or could not load: what the explorer is doing about it. */
  explorerLabel(): string {
    const s = this.explorerStatus;
    const host = (b: string) => b.replace(/^https:\/\//, "");
    if (s?.state === "retrying") return `explorer unavailable (${host(s.base)}, try ${s.attempt} failed), retrying…`;
    if (s?.state === "failed") return `explorer unavailable (${s.error}); retrying at the next refresh`;
    return "loading from the explorer…";
  }

  get wallet(): Wallet | undefined {
    return this.state.wallet;
  }

  subscribe(topic: Topic, fn: () => void): () => void {
    const set = this.#subs.get(topic) ?? new Set();
    set.add(fn);
    this.#subs.set(topic, set);
    return () => set.delete(fn);
  }

  notify(topic: Topic) {
    for (const fn of this.#subs.get(topic) ?? []) fn();
  }

  setWallet(w: Wallet | undefined) {
    this.state.wallet = w;
    this.notify("wallet");
  }

  /** The wallet's addresses, for "(you)" marks; empty with no wallet. */
  get addresses(): string[] {
    return this.state.wallet?.usedAddresses ?? [];
  }

  isMine(address: string): boolean {
    return this.addresses.includes(address);
  }

  nameOf(id: string): string {
    if (id === ERG) return "ERG";
    return this.tokens.get(id)?.name || id.slice(0, 8);
  }

  decimalsOf(id: string): number {
    if (id === ERG) return ERG_DECIMALS;
    return this.tokens.get(id)?.decimals ?? 0;
  }

  rememberToken(id: string, name: string, decimals: number) {
    if (!this.tokens.has(id)) this.tokens.set(id, { id, name, decimals });
  }

  async tokenInfo(id: string): Promise<TokenInfo> {
    let t = this.tokens.get(id);
    if (!t) {
      try {
        t = await this.explorer.token(id);
      } catch {
        t = { id, name: "", decimals: 0 };
      }
      this.tokens.set(id, t);
    }
    return t;
  }

  whitelisted(id: string): boolean {
    return tokenlist.tokens.some((t) => t.id === id);
  }

  /** The deepest live ERG pool for a token id, if the explorer listed one. */
  deepestPool(tokenId: string): PoolEntry | undefined {
    return this.state.pools
      .filter((p) => p.box.assets[2].tokenId === tokenId)
      .sort((a, b) => (b.box.value > a.box.value ? 1 : -1))[0];
  }

  /** The token-to-token pool holding both tokens with the most of `inId`. */
  deepestT2T(inId: string, outId: string): T2TPoolEntry | undefined {
    const has = (e: T2TPoolEntry, id: string) => e.box.assets[2].tokenId === id || e.box.assets[3].tokenId === id;
    return this.state.t2tPools
      .filter((e) => has(e, inId) && has(e, outId))
      .sort((a, b) =>
        t2tSides(describeT2TPool(b.box), inId).reserveIn > t2tSides(describeT2TPool(a.box), inId).reserveIn ? 1 : -1,
      )[0];
  }

  /** Whether any pool, ERG or token-to-token, holds the token. */
  pooled(id: string): boolean {
    return (
      !!this.deepestPool(id) ||
      this.state.t2tPools.some((e) => e.box.assets[2].tokenId === id || e.box.assets[3].tokenId === id)
    );
  }

  /** Both pool listings from the explorer; token names from them; the Swap tab's default target. */
  async loadPools(): Promise<boolean> {
    const s = this.state;
    try {
      [s.pools, s.t2tPools] = await Promise.all([this.explorer.pools(500), this.explorer.t2tPools(500)]);
      s.pools.sort((a, b) => (b.box.value > a.box.value ? 1 : -1));
      for (const p of s.pools) this.rememberToken(p.box.assets[2].tokenId, p.tokenName, p.tokenDecimals);
      for (const e of s.t2tPools) {
        this.rememberToken(e.box.assets[2].tokenId, e.xName, e.xDecimals);
        this.rememberToken(e.box.assets[3].tokenId, e.yName, e.yDecimals);
      }
      if (!s.toId) s.toId = tokenlist.tokens.find((t) => t.name === "SigUSD")?.id ?? tokenlist.tokens[0]?.id ?? "";
      s.poolsError = undefined;
      this.notify("pools");
      log(
        `${s.pools.length} ERG pools and ${s.t2tPools.length} token-to-token pools listed by the explorer; ${tokenlist.tokens.length} tokens in the static list (${tokenlist.generated})`,
      );
      return true;
    } catch (e) {
      s.poolsError = err(e);
      log(`could not load pools: ${err(e)}`);
      this.notify("pools");
      return false;
    }
  }

  /** The bank and its oracle as they stand now; throws if the explorer has neither. */
  async loadBank(): Promise<SigmaUSDBank> {
    this.state.bank = await loadBank(this.explorer);
    this.notify("bank");
    return this.state.bank;
  }

  /** Open Machina orders and Babel boxes, with their tokens' names; throws on an explorer failure. */
  async loadOrders(): Promise<void> {
    const s = this.state;
    [s.orderBoxes, s.babelBoxes] = await Promise.all([this.explorer.limitOrders(200), this.explorer.babelBoxes(500)]);
    const ids = new Set<string>();
    for (const b of s.orderBoxes) {
      try {
        ids.add(describeOrder(b).tokenId);
      } catch {
        /* not an order */
      }
    }
    for (const b of s.babelBoxes) {
      try {
        ids.add(describeBabel(b).tokenId);
      } catch {
        /* not a Babel box */
      }
    }
    await Promise.all([...ids].map((id) => this.tokenInfo(id)));
    this.notify("orders");
  }
}
