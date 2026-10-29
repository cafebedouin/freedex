// The Options tab: the option as a timed escrow (contracts/Call.es and contracts/Put.es). Write one (a call locks
// tokens, a put locks the ERG collateral), the visitor's own positions first (written and held, with the exercise,
// cancel and reclaim buttons only when the contract would accept them), then every open offer on either contract
// grouped by token with its premium and expiry, which anyone may buy.
import type { Box } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import { BLOCKS_PER_DAY, RENT_PERIOD, describeInterval } from "../clock";
import {
  CALL_TEMPLATE_SHA256,
  PUT_TEMPLATE_SHA256,
  buildBuy,
  buildExercise,
  buildReclaim,
  buildWrite,
  canBuy,
  canExercise,
  canReclaim,
  describeOption,
  sizeWrite,
  type OptionSide,
  type OptionTerms,
  type OptionView,
} from "../option";
import { ERG_DECIMALS, ergPerTokenToPrice, formatUnits, parseUnits, priceToErgPerToken } from "../units";
import { $, dl, err, h, log, option, table, td, tdCode } from "./dom";
import { OTHER, type Store } from "./store";
import { send } from "./wallet";

type Row = { box: Box<bigint>; v: OptionView };
const GENERATOR = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export function mountOptions(store: Store) {
  const reload = () => setTimeout(() => void loadOptions(), 3000);
  let height = 0;
  const side = () => $<HTMLSelectElement>("opt-side").value as OptionSide;

  function fillTokens() {
    const sel = $<HTMLSelectElement>("opt-token-pick");
    sel.replaceChildren();
    for (const p of store.state.pools) {
      const id = p.box.assets[2].tokenId;
      if (!store.whitelisted(id) || [...sel.options].some((o) => o.value === id)) continue;
      sel.append(option(store.nameOf(id), id));
    }
    sel.append(option("other (type the id below)", OTHER));
    sel.onchange = () => {
      $<HTMLInputElement>("opt-token").value = sel.value === OTHER ? "" : sel.value;
      quoteWrite();
    };
    $<HTMLInputElement>("opt-token").value = sel.value === OTHER ? "" : sel.value;
  }

  function relabel() {
    const call = side() === "call";
    $("opt-amount-label").textContent = call
      ? "Tokens to lock (the buyer may buy them)"
      : "Tokens the buyer may sell you";
    $("opt-strike-label").textContent = call
      ? "Strike (ERG per token the buyer pays)"
      : "Strike (ERG per token you pay; the collateral is locked now)";
  }

  /** What the form would write at `height`, or the reason it cannot. */
  function readForm(height: number): OptionTerms {
    const tokenId = $<HTMLInputElement>("opt-token").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(tokenId)) throw new Error("token id: 64 hex characters");
    const decimals = store.decimalsOf(tokenId);
    const amount = parseUnits($<HTMLInputElement>("opt-amount").value || "0", decimals);
    const strike = ergPerTokenToPrice($<HTMLInputElement>("opt-strike").value || "0", decimals);
    const blocks = Number($<HTMLInputElement>("opt-expiry").value);
    if (!Number.isInteger(blocks) || blocks < 1) throw new Error("expiry must be a whole number of blocks from now");
    const premium = parseUnits($<HTMLInputElement>("opt-premium").value || "0", ERG_DECIMALS);
    return {
      side: side(),
      // without a wallet the quote still needs a 33-byte key to size the box: the curve's generator, never an output
      writer: store.wallet?.changeAddress ?? ErgoAddress.fromPublicKey(GENERATOR),
      tokenId,
      amount,
      strike,
      expiry: height + blocks,
      premium,
    };
  }

  function quoteWrite() {
    const q = $<HTMLDListElement>("opt-quote");
    const go = $<HTMLButtonElement>("opt-go");
    try {
      const t = readForm(height);
      const s = sizeWrite(t, height);
      const dec = store.decimalsOf(t.tokenId);
      const name = store.nameOf(t.tokenId);
      const strikeTotal = formatUnits(t.strike * t.amount, ERG_DECIMALS);
      const blocks = t.expiry - height;
      const rows: [string, string][] = [
        ["expiry", `height ${t.expiry}, ${describeInterval(blocks)} from now; exercisable at or before it`],
        [
          "premium",
          `${formatUnits(t.premium, ERG_DECIMALS)} ERG to you when someone buys the option; yours either way`,
        ],
      ];
      if (t.side === "call") {
        rows.push(
          [
            "locked now",
            `${formatUnits(t.amount, dec)} ${name} and ${formatUnits(s.value, ERG_DECIMALS)} ERG plus the miner fee`,
          ],
          [
            "rent reserve",
            `${formatUnits(s.rentReserve, ERG_DECIMALS)} ERG, one storage-rent fee for ${s.bytes} bytes, because a token box that cannot pay rent is consumed whole; back to you on exercise or reclaim`,
          ],
          ["on exercise", `you receive ${strikeTotal} ERG (the strike) and the reserve; the buyer takes the ${name}`],
          [
            "after expiry",
            `the ${name} and the reserve come back to you (the page reclaims it for you while you are here)`,
          ],
        );
      } else {
        rows.push(
          ["locked now", `${strikeTotal} ERG, the collateral (strike x amount), plus the miner fee`],
          ["on exercise", `you receive ${formatUnits(t.amount, dec)} ${name}; the buyer takes the ${strikeTotal} ERG`],
          [
            "after expiry",
            `the ${strikeTotal} ERG comes back to you (the page reclaims it for you while you are here)`,
          ],
        );
      }
      dl(q, rows);
      go.disabled = !store.wallet;
    } catch (e) {
      dl(q, [["", err(e)]]);
      go.disabled = true;
    }
  }

  function row({ box, v }: Row): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const writer = store.isMine(v.writer),
      buyer = !!v.buyer && store.isMine(v.buyer);
    if (writer || buyer) tr.className = "mine";
    const name = store.nameOf(v.tokenId);
    const dec = store.decimalsOf(v.tokenId);
    const left = v.expiry - height;
    const when = left > 0 ? `in ${left} blocks` : left === 0 ? "this block" : "expired";
    tr.append(
      td(name),
      td(v.side),
      td(`${formatUnits(v.amount, dec)} ${name}`, "num"),
      td(`${priceToErgPerToken(v.strike, dec)} ERG`, "num"),
      td(`${formatUnits(v.premium, ERG_DECIMALS)} ERG`, "num"),
      td(`${v.expiry} (${when})`),
      tdCode(v.writer, `${v.writer.slice(0, 6)}…`, writer ? " (you)" : ""),
      v.buyer ? tdCode(v.buyer, `${v.buyer.slice(0, 6)}…`, buyer ? " (you)" : "") : td("unsold", "muted"),
    );
    const actions = document.createElement("td");
    const wallet = store.wallet;
    const button = (label: string, build: Parameters<typeof send>[1]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () =>
        send(store, build)
          .then(reload)
          .catch((e) => log(`${label} failed: ${err(e)}`));
      actions.append(b, " ");
    };
    if (wallet && !writer && canBuy(v, height))
      button("pay the premium and buy", (hh, inputs) =>
        buildBuy({ height: hh, inputs, buyer: wallet.changeAddress, optionBox: box }),
      );
    if (wallet && buyer && canExercise(v, height, wallet.changeAddress.encode()))
      button("exercise", (hh, inputs) =>
        buildExercise({ height: hh, inputs, buyer: wallet.changeAddress, optionBox: box }),
      );
    if (wallet && writer && canReclaim(v, height))
      button(v.expiry <= height ? "reclaim" : "cancel", (hh, inputs) =>
        buildReclaim({ height: hh, inputs, writer: wallet.changeAddress, optionBox: box }),
      );
    tr.append(actions);
    return tr;
  }

  const HEADS = ["Token", "Side", "Amount", "Strike", "Premium", "Expiry", "Writer", "Buyer", ""];

  async function loadOptions() {
    try {
      const [calls, puts, hh] = await Promise.all([
        store.explorer.byTemplate(CALL_TEMPLATE_SHA256, 500),
        store.explorer.byTemplate(PUT_TEMPLATE_SHA256, 500),
        store.explorer.height(),
      ]);
      height = hh;
      const all: Row[] = [...calls, ...puts].flatMap((box) => {
        try {
          return [{ box, v: describeOption(box) }];
        } catch {
          return [];
        }
      });
      for (const { v } of all) if (!store.tokens.has(v.tokenId)) await store.tokenInfo(v.tokenId);
      const mine = all.filter(({ v }) => store.isMine(v.writer) || (!!v.buyer && store.isMine(v.buyer)));
      const others = all.filter((r) => !mine.includes(r) && !r.v.sold && r.v.expiry > height);
      $("options-mine").replaceChildren(
        !store.wallet ? "connect a wallet to see your options" : mine.length ? table(HEADS, mine.map(row)) : "none",
      );
      const groups = new Map<string, Row[]>();
      for (const r of others) groups.set(r.v.tokenId, [...(groups.get(r.v.tokenId) ?? []), r]);
      const list = $("options-list");
      list.replaceChildren();
      if (groups.size === 0) list.textContent = "no open offers on either contract";
      for (const [tokenId, rows] of groups) {
        rows.sort((a, b) => (a.v.premium < b.v.premium ? -1 : 1));
        list.append(h("h3", `${store.nameOf(tokenId)} (${rows.length})`), table(HEADS, rows.map(row)));
      }
      quoteWrite();
    } catch (e) {
      $("options-list").textContent = `could not load: ${err(e)}`;
    }
  }

  for (const id of ["opt-token", "opt-amount", "opt-strike", "opt-expiry", "opt-premium"])
    $<HTMLInputElement>(id).oninput = () => {
      if (id === "opt-expiry") {
        const n = Number($<HTMLInputElement>("opt-expiry").value);
        $("opt-expiry-days").textContent =
          Number.isInteger(n) && n > 0 ? describeInterval(n).replace(/^\d+ blocks /, "") : "";
      }
      quoteWrite();
    };
  $<HTMLSelectElement>("opt-side").onchange = () => {
    relabel();
    quoteWrite();
  };

  $<HTMLFormElement>("write-option").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const blocks = Number($<HTMLInputElement>("opt-expiry").value);
      if (blocks > RENT_PERIOD)
        throw new Error(`the expiry must be within ${RENT_PERIOD} blocks (${RENT_PERIOD / BLOCKS_PER_DAY} days)`);
      const tokenId = $<HTMLInputElement>("opt-token").value.trim().toLowerCase();
      await store.tokenInfo(tokenId);
      await send(store, (hh, inputs) => buildWrite({ ...readForm(hh), height: hh, inputs }));
      reload();
    } catch (e) {
      log(`write failed: ${err(e)}`);
    }
  };

  store.subscribe("pools", () => {
    fillTokens();
    quoteWrite();
  });
  store.subscribe("wallet", () => {
    quoteWrite();
    void loadOptions();
  });

  relabel();
  return { show: () => void loadOptions() };
}
