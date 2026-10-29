// The Limit orders tab: Machina E2T limit orders and EIP-31 Babel boxes (standing bids anyone sells tokens into),
// grouped by token, best price first on each side; place, fill and close.
import type { Box } from "@fleet-sdk/common";
import { babelCapacity, buildFillBabel, describeBabel } from "../babel";
import { buildClose, buildCreate, buildFill, capacity, describe, type OwnerSide, type TakerAction } from "../orders";
import tokenlist from "../tokenlist.json" with { type: "json" };
import { ERG_DECIMALS, ergPerTokenToPrice, formatUnits, parseUnits, priceToErgPerToken } from "../units";
import { $, err, h, log, table, td, tdCode, option } from "./dom";
import type { Store } from "./store";
import { send } from "./wallet";

/** One row on the tab: a Machina order or a Babel box, seen as what a taker may do at what price. */
export interface Listing {
  kind: "machina" | "babel";
  box: Box<bigint>;
  tokenId: string;
  takerAction: TakerAction;
  /** nanoERG per smallest token unit */
  price: bigint;
  /** tokens a taker can still buy from, or sell into, the box */
  capacity: bigint;
  /** nanoERG held by the box */
  value: bigint;
  owner: string;
}

export interface Group {
  tokenId: string;
  rows: Listing[];
  /** takers buy tokens from these, cheapest first */
  buys: Listing[];
  /** takers sell tokens into these, dearest first */
  sells: Listing[];
}

/** Orders and Babel boxes as listings; a box the describers reject (malformed registers) is skipped. */
export function listings(orderBoxes: Box<bigint>[], babelBoxes: Box<bigint>[]): Listing[] {
  const out: Listing[] = [];
  for (const box of orderBoxes) {
    try {
      const v = describe(box);
      out.push({
        kind: "machina",
        box,
        tokenId: v.tokenId,
        takerAction: v.takerAction,
        price: v.price,
        capacity: capacity(v),
        value: v.value,
        owner: v.owner,
      });
    } catch {
      /* a box under the template that the SDK rejects: skip */
    }
  }
  for (const box of babelBoxes) {
    try {
      const v = describeBabel(box);
      const cap = babelCapacity(v);
      if (cap > 0n)
        out.push({
          kind: "babel",
          box,
          tokenId: v.tokenId,
          takerAction: "sell",
          price: v.bid,
          capacity: cap,
          value: v.value,
          owner: v.owner,
        });
    } catch {
      /* not a Babel box */
    }
  }
  return out;
}

/** Grouped by token, most listings first; inside, takers' buys cheapest first and takers' sells dearest first. */
export function groupListings(ls: Listing[]): Group[] {
  const groups = new Map<string, Listing[]>();
  for (const l of ls) (groups.get(l.tokenId) ?? groups.set(l.tokenId, []).get(l.tokenId)!).push(l);
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tokenId, rows]) => ({
      tokenId,
      rows,
      buys: rows.filter((r) => r.takerAction === "buy").sort((a, b) => (a.price < b.price ? -1 : 1)),
      sells: rows.filter((r) => r.takerAction === "sell").sort((a, b) => (a.price > b.price ? -1 : 1)),
    }));
}

export function mountOrders(store: Store) {
  async function loadOrders() {
    try {
      await store.loadOrders();
    } catch (e) {
      $("orders").textContent = `could not load orders: ${err(e)}`;
    }
  }
  const reload = () => setTimeout(() => void loadOrders(), 3000);

  function row(l: Listing, decimals: number): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const mine = store.isMine(l.owner);
    if (mine) tr.className = "mine";
    tr.append(
      td(priceToErgPerToken(l.price, decimals), "num"),
      td(
        `${formatUnits(l.capacity, decimals)}${l.takerAction === "sell" ? ` (${formatUnits(l.value, ERG_DECIMALS)} ERG)` : ""}`,
        "num",
      ),
      tdCode(l.owner, `${l.owner.slice(0, 6)}…`, (mine ? " (you)" : "") + (l.kind === "babel" ? " Babel" : "")),
    );
    const actions = document.createElement("td");
    const wallet = store.wallet;
    if (wallet && l.kind === "machina" && mine) {
      const b = document.createElement("button");
      b.textContent = "close";
      b.onclick = () =>
        send(store, (height, inputs) => buildClose({ height, inputs, owner: wallet.changeAddress, orderBox: l.box }))
          .then(reload)
          .catch((e) => log(`close failed: ${err(e)}`));
      actions.append(b);
    } else if (wallet && !mine) {
      const amount = document.createElement("input");
      amount.size = 10;
      amount.placeholder = formatUnits(l.capacity, decimals);
      const b = document.createElement("button");
      b.textContent = l.takerAction === "buy" ? "buy" : "sell";
      b.onclick = () => {
        try {
          const n = parseUnits(amount.value || amount.placeholder, decimals);
          const build =
            l.kind === "babel"
              ? (height: number, inputs: Box<string>[]) =>
                  buildFillBabel({ height, inputs, taker: wallet.changeAddress, babelBox: l.box, tokenAmount: n })
              : (height: number, inputs: Box<string>[]) =>
                  buildFill({ height, inputs, taker: wallet.changeAddress, orderBox: l.box, tokenAmount: n });
          void send(store, build)
            .then(reload)
            .catch((e) => log(`fill failed: ${err(e)}`));
        } catch (e) {
          log(`fill: ${err(e)}`);
        }
      };
      actions.append(amount, " ", b);
    }
    tr.append(actions);
    return tr;
  }

  function sideTable(title: string, rows: Listing[], decimals: number): HTMLElement[] {
    if (rows.length === 0) return [];
    return [
      h("h3", title),
      table(
        ["Price (ERG/token)", "Available", "Owner", ""],
        rows.map((l) => row(l, decimals)),
      ),
    ];
  }

  function renderOrders() {
    const out: HTMLElement[] = [];
    for (const g of groupListings(listings(store.state.orderBoxes, store.state.babelBoxes))) {
      const t = store.tokens.get(g.tokenId) ?? { id: g.tokenId, name: "", decimals: 0 };
      const det = document.createElement("details");
      if (g.rows.some((r) => store.isMine(r.owner))) det.open = true;
      const sum = document.createElement("summary");
      const best: string[] = [];
      if (g.buys.length) best.push(`buy from ${priceToErgPerToken(g.buys[0].price, t.decimals)}`);
      if (g.sells.length) best.push(`sell at ${priceToErgPerToken(g.sells[0].price, t.decimals)}`);
      const muted = document.createElement("span");
      muted.className = "muted";
      muted.textContent = `${g.rows.length} order${g.rows.length === 1 ? "" : "s"}; best: ${best.join(", ")} ERG/token`;
      sum.append(`${t.name || g.tokenId.slice(0, 10)} `, muted);
      det.append(
        sum,
        ...sideTable("You buy tokens from these orders", g.buys, t.decimals),
        ...sideTable("You sell tokens into these orders", g.sells, t.decimals),
      );
      out.push(det);
    }
    $("orders").replaceChildren(...(out.length ? out : ["no open orders"]));
  }

  /** The create form's token list: the static whitelist; the id field stays editable for any other token. */
  function renderTokenPick() {
    const sel = $<HTMLSelectElement>("token-pick");
    sel.replaceChildren(option("other (type the id below)", ""));
    for (const t of tokenlist.tokens) {
      sel.append(option(t.name || t.id.slice(0, 10), t.id));
      store.tokens.set(t.id, { id: t.id, name: t.name, decimals: t.decimals });
    }
    sel.onchange = () => {
      $<HTMLInputElement>("token").value = sel.value;
    };
  }

  $<HTMLSelectElement>("side").onchange = () => {
    $("amount-label").textContent =
      $<HTMLSelectElement>("side").value === "sell-tokens" ? "Token amount" : "ERG to spend";
  };

  $<HTMLFormElement>("create").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const side = $<HTMLSelectElement>("side").value as OwnerSide;
      const tokenId = $<HTMLInputElement>("token").value.trim().toLowerCase();
      const t = await store.tokenInfo(tokenId);
      const price = ergPerTokenToPrice($<HTMLInputElement>("price").value, t.decimals);
      const amountText = $<HTMLInputElement>("amount").value;
      const params =
        side === "sell-tokens"
          ? { tokenAmount: parseUnits(amountText, t.decimals) }
          : { ergAmount: parseUnits(amountText, ERG_DECIMALS) };
      log(`${side} ${t.name || tokenId.slice(0, 10)} at ${price} nanoERG per unit`);
      const owner = store.wallet!.changeAddress;
      await send(store, (height, inputs) =>
        buildCreate({ height, inputs, owner, side, quoteTokenId: tokenId, price, ...params }),
      );
      reload();
    } catch (e) {
      log(`create failed: ${err(e)}`);
    }
  };

  store.subscribe("orders", renderOrders);
  store.subscribe("wallet", renderOrders);
  store.subscribe("pools", renderTokenPick);
  return { load: loadOrders };
}
