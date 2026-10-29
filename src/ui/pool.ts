// The Pool tab: add or remove liquidity on ErgoDEX v1 ERG pairs and token pairs, straight to the pool box.
import {
  buildDeposit,
  buildDepositT2T,
  buildRedeem,
  buildRedeemT2T,
  depositQuote,
  depositQuoteFromTokens,
  depositQuoteT2T,
  depositQuoteT2TFromY,
  describePool,
  describeT2TPool,
  lpSupply,
  lpSupplyT2T,
  redeemQuote,
  redeemQuoteT2T,
} from "../amm";
import type { PoolEntry, T2TPoolEntry } from "../explorer";
import { FEE } from "../orders";
import tokenlist from "../tokenlist.json" with { type: "json" };
import { ERG_DECIMALS, formatUnits, parseUnits } from "../units";
import { $, dl, err, log, option } from "./dom";
import { ERG, type Store } from "./store";
import { send } from "./wallet";

export type Pair = { kind: "n2t"; tokenId: string } | { kind: "t2t"; nft: string };
export type PairSides = { a: string; b: string; n2t?: PoolEntry; t2t?: T2TPoolEntry };

/** Returns [aIn, bIn, lpOut] for the typed side, deriving the other at the pool's ratio. */
export function depositAmounts(
  store: Store,
  ps: PairSides,
  typedSide: "a" | "b",
  typedText: string,
): [bigint, bigint, bigint] {
  if (ps.n2t) {
    const pool = describePool(ps.n2t.box);
    if (typedSide === "a") {
      const ergIn = parseUnits(typedText, ERG_DECIMALS);
      const q = depositQuote(pool, ergIn);
      return [ergIn, q.tokenIn, q.lpOut];
    }
    const tokenIn = parseUnits(typedText, store.decimalsOf(ps.b));
    const q = depositQuoteFromTokens(pool, tokenIn);
    return [q.ergIn, tokenIn, q.lpOut];
  }
  const pool = describeT2TPool(ps.t2t!.box);
  if (typedSide === "a") {
    const xIn = parseUnits(typedText, store.decimalsOf(ps.a));
    const q = depositQuoteT2T(pool, xIn);
    return [xIn, q.yIn, q.lpOut];
  }
  const yIn = parseUnits(typedText, store.decimalsOf(ps.b));
  const q = depositQuoteT2TFromY(pool, yIn);
  return [q.xIn, yIn, q.lpOut];
}

export function mountPool(store: Store) {
  let pair: Pair | undefined;
  let lpSideTyped: "a" | "b" = "a";
  const sel = $<HTMLSelectElement>("lp-token");
  const aEl = $<HTMLInputElement>("lp-erg");
  const bEl = $<HTMLInputElement>("lp-tok");
  const lpInEl = $<HTMLInputElement>("lp-in");

  const parsePair = (v: string): Pair => {
    const [kind, id] = v.split(":");
    return kind === "n2t" ? { kind: "n2t", tokenId: id } : { kind: "t2t", nft: id };
  };

  /** Pairs: ERG with each whitelisted token, then token-to-token pools whose two tokens are both whitelisted. */
  function renderPairSelect() {
    const current = sel.value;
    sel.replaceChildren();
    for (const t of tokenlist.tokens) sel.append(option(`ERG / ${t.name || t.id.slice(0, 8)}`, `n2t:${t.id}`));
    for (const e of store.state.t2tPools) {
      const x = e.box.assets[2].tokenId,
        y = e.box.assets[3].tokenId;
      if (store.whitelisted(x) && store.whitelisted(y))
        sel.append(option(`${store.nameOf(x)} / ${store.nameOf(y)}`, `t2t:${e.box.assets[0].tokenId}`));
    }
    if (current) sel.value = current;
    sel.onchange = () => {
      pair = parsePair(sel.value);
      aEl.value = "";
      bEl.value = "";
      void renderPool();
    };
  }

  /** The two sides of the selected pair: [a, b] asset ids, and the live pool. */
  function pairSides(): PairSides | undefined {
    if (!pair) return undefined;
    if (pair.kind === "n2t") {
      const n2t = store.deepestPool(pair.tokenId);
      return n2t ? { a: ERG, b: pair.tokenId, n2t } : undefined;
    }
    const nft = pair.nft;
    const t2t = store.state.t2tPools.find((e) => e.box.assets[0].tokenId === nft);
    return t2t ? { a: t2t.box.assets[2].tokenId, b: t2t.box.assets[3].tokenId, t2t } : undefined;
  }

  async function renderPool() {
    if (!pair) {
      if (!sel.value) return;
      pair = parsePair(sel.value);
    }
    const ps = pairSides();
    if (!ps) {
      dl($("lp-info"), [
        ["Pool", "no pool listed for this pair yet (the explorer is still loading, or the pair has none)"],
      ]);
      return;
    }
    $("lp-erg-name").textContent = store.nameOf(ps.a);
    $("lp-tok-name").textContent = store.nameOf(ps.b);
    const rows: [string, string][] = [];
    let lpTokenId: string, feeNum: bigint, supply: bigint;
    let share: (lp: bigint) => [bigint, bigint];
    if (ps.n2t) {
      const pool = describePool(ps.n2t.box);
      lpTokenId = pool.lpTokenId;
      feeNum = pool.feeNum;
      supply = lpSupply(pool);
      rows.push([
        "Reserves",
        `${formatUnits(pool.x, ERG_DECIMALS, 3)} ERG and ${formatUnits(pool.y, store.decimalsOf(ps.b))} ${store.nameOf(ps.b)}`,
      ]);
      share = (lp) => {
        const q = redeemQuote(pool, lp);
        return [q.ergOut, q.tokenOut];
      };
    } else {
      const pool = describeT2TPool(ps.t2t!.box);
      lpTokenId = pool.lpTokenId;
      feeNum = pool.feeNum;
      supply = lpSupplyT2T(pool);
      rows.push([
        "Reserves",
        `${formatUnits(pool.x, store.decimalsOf(ps.a))} ${store.nameOf(ps.a)} and ${formatUnits(pool.y, store.decimalsOf(ps.b))} ${store.nameOf(ps.b)}`,
      ]);
      share = (lp) => {
        const q = redeemQuoteT2T(pool, lp);
        return [q.xOut, q.yOut];
      };
    }
    rows.push(["LP in circulation", supply.toString()]);
    rows.push(["Pool fee", `${formatUnits(1000n - feeNum, 1)}% to liquidity providers`]);
    const wallet = store.wallet;
    if (wallet) {
      try {
        const lp = await wallet.balance(lpTokenId);
        const [sa, sb] = share(lp);
        rows.push([
          "Your LP tokens",
          `${lp} (${formatUnits(sa, store.decimalsOf(ps.a), 4)} ${store.nameOf(ps.a)} and ${formatUnits(sb, store.decimalsOf(ps.b))} ${store.nameOf(ps.b)})`,
        ]);
        $<HTMLButtonElement>("lp-max").onclick = () => {
          lpInEl.value = lp.toString();
          renderRedeemQuote();
        };
      } catch (e) {
        rows.push(["Your LP tokens", err(e)]);
      }
    }
    dl($("lp-info"), rows);
    renderDepositQuote();
    renderRedeemQuote();
  }

  function renderDepositQuote() {
    const btn = $<HTMLButtonElement>("lp-add");
    btn.disabled = true;
    const ps = pairSides();
    if (!ps) return;
    try {
      const typed = (lpSideTyped === "a" ? aEl : bEl).value.trim();
      if (!typed) {
        (lpSideTyped === "a" ? bEl : aEl).value = "";
        dl($("lp-quote"), []);
        return;
      }
      const [aIn, bIn, lpOut] = depositAmounts(store, ps, lpSideTyped, typed);
      if (lpSideTyped === "a") bEl.value = formatUnits(bIn, store.decimalsOf(ps.b));
      else aEl.value = formatUnits(aIn, store.decimalsOf(ps.a));
      const supply = (ps.n2t ? lpSupply(describePool(ps.n2t.box)) : lpSupplyT2T(describeT2TPool(ps.t2t!.box))) + lpOut;
      dl($("lp-quote"), [
        ["LP tokens you receive", lpOut.toString()],
        ["Your share after", `${formatUnits((lpOut * 1_000_000n) / supply, 4)}%`],
        ["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG`],
      ]);
      btn.disabled = !store.wallet || lpOut <= 0n;
    } catch (e) {
      dl($("lp-quote"), [["Amount", err(e)]]);
    }
  }

  function renderRedeemQuote() {
    const btn = $<HTMLButtonElement>("lp-remove");
    btn.disabled = true;
    const ps = pairSides();
    if (!ps) return;
    try {
      const text = lpInEl.value.trim();
      if (!text) {
        dl($("lp-redeem-quote"), []);
        return;
      }
      const lpIn = parseUnits(text, 0);
      let a: bigint, b: bigint;
      if (ps.n2t) {
        const q = redeemQuote(describePool(ps.n2t.box), lpIn);
        [a, b] = [q.ergOut, q.tokenOut];
      } else {
        const q = redeemQuoteT2T(describeT2TPool(ps.t2t!.box), lpIn);
        [a, b] = [q.xOut, q.yOut];
      }
      dl($("lp-redeem-quote"), [
        [
          "You receive",
          `${formatUnits(a, store.decimalsOf(ps.a))} ${store.nameOf(ps.a)} and ${formatUnits(b, store.decimalsOf(ps.b))} ${store.nameOf(ps.b)}`,
        ],
        ["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG`],
      ]);
      btn.disabled = !store.wallet || (a <= 0n && b <= 0n);
    } catch (e) {
      dl($("lp-redeem-quote"), [["Amount", err(e)]]);
    }
  }

  aEl.oninput = () => {
    lpSideTyped = "a";
    renderDepositQuote();
  };
  bEl.oninput = () => {
    lpSideTyped = "b";
    renderDepositQuote();
  };
  lpInEl.oninput = renderRedeemQuote;
  $<HTMLButtonElement>("lp-add").onclick = async () => {
    try {
      const ps = pairSides();
      if (!ps) throw new Error("pick a pair");
      const typed = (lpSideTyped === "a" ? aEl : bEl).value;
      const user = store.wallet!.changeAddress;
      if (ps.n2t) {
        const fresh = await store.explorer.poolByNft(ps.n2t.box.assets[0].tokenId);
        const [ergIn] = depositAmounts(store, { ...ps, n2t: fresh }, lpSideTyped, typed);
        await send(store, (height, inputs) => buildDeposit({ height, inputs, user, poolBox: fresh.box, ergIn }));
      } else {
        const fresh = await store.explorer.t2tPoolByNft(ps.t2t!.box.assets[0].tokenId);
        const [xIn] = depositAmounts(store, { ...ps, t2t: fresh }, lpSideTyped, typed);
        await send(store, (height, inputs) => buildDepositT2T({ height, inputs, user, poolBox: fresh.box, xIn }));
      }
      aEl.value = "";
      bEl.value = "";
      setTimeout(() => void store.loadPools().then(renderPool), 3000);
    } catch (e) {
      log(`add liquidity failed: ${err(e)}`);
    }
  };
  $<HTMLButtonElement>("lp-remove").onclick = async () => {
    try {
      const ps = pairSides();
      if (!ps) throw new Error("pick a pair");
      const lpIn = parseUnits(lpInEl.value, 0);
      const user = store.wallet!.changeAddress;
      if (ps.n2t) {
        const fresh = await store.explorer.poolByNft(ps.n2t.box.assets[0].tokenId);
        await send(store, (height, inputs) => buildRedeem({ height, inputs, user, poolBox: fresh.box, lpIn }));
      } else {
        const fresh = await store.explorer.t2tPoolByNft(ps.t2t!.box.assets[0].tokenId);
        await send(store, (height, inputs) => buildRedeemT2T({ height, inputs, user, poolBox: fresh.box, lpIn }));
      }
      lpInEl.value = "";
      setTimeout(() => void store.loadPools().then(renderPool), 3000);
    } catch (e) {
      log(`remove liquidity failed: ${err(e)}`);
    }
  };

  store.subscribe("pools", renderPairSelect);
  return { show: () => void renderPool() };
}
