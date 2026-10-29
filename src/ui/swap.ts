// The Swap tab: ErgoDEX v1 ERG pools and token-to-token pools, a direct swap against the pool box, the SigmaUSD
// bank quoted beside the pool for its two tokens.
import {
  buildSwap,
  buildSwapT2T,
  describePool,
  describeT2TPool,
  priceImpactBps,
  priceImpactBpsT2T,
  quote,
  quoteT2T,
  t2tSides,
  type SwapDirection,
} from "../amm";
import { coinOf, mintQuote, redeemQuote as bankRedeemQuote } from "../bank";
import type { PoolEntry, T2TPoolEntry } from "../explorer";
import { FEE } from "../orders";
import tokenlist from "../tokenlist.json" with { type: "json" };
import { ERG_DECIMALS, formatUnits, parseUnits } from "../units";
import { $, dl, err, log, option } from "./dom";
import { ERG, OTHER, type Store } from "./store";
import { send } from "./wallet";

export type Route =
  | { kind: "n2t"; entry: PoolEntry; direction: SwapDirection }
  | { kind: "t2t"; entry: T2TPoolEntry }
  | { kind: "none"; why: string };

/** ERG-to-token through the deepest ERG pool; token-to-token through a direct pool, else none. */
export function route(store: Store): Route {
  const { fromId, toId } = store.state;
  if (!fromId || !toId) return { kind: "none", why: "pick both assets" };
  if (fromId === toId) return { kind: "none", why: "pick two different assets" };
  if (fromId === ERG || toId === ERG) {
    const tokenId = fromId === ERG ? toId : fromId;
    const entry = store.deepestPool(tokenId);
    if (!entry) return { kind: "none", why: `no ErgoDEX ERG pool holds ${store.nameOf(tokenId)}` };
    return { kind: "n2t", entry, direction: fromId === ERG ? "erg-to-token" : "token-to-erg" };
  }
  const entry = store.deepestT2T(fromId, toId);
  if (!entry)
    return {
      kind: "none",
      why: `no direct ${store.nameOf(fromId)}/${store.nameOf(toId)} pool: swap to ERG first, then to ${store.nameOf(toId)}`,
    };
  return { kind: "t2t", entry };
}

export function mountSwap(store: Store) {
  const s = store.state;
  const swapIn = $<HTMLInputElement>("swap-in");
  const swapOut = $<HTMLInputElement>("swap-out");
  const swapFrom = $<HTMLSelectElement>("swap-from");
  const swapTo = $<HTMLSelectElement>("swap-to");
  const swapGo = $<HTMLButtonElement>("swap-go");
  /** The quote the user last saw: its minimum after slippage is what a freshly read pool must still pay. */
  let shown: { amountIn: bigint; minOut: bigint } | undefined;
  let otherSide: "from" | "to" = "to";

  /** ERG, the whitelist (with the live ERG pool's depth), then "other". */
  function fillAssetSelect(sel: HTMLSelectElement, current: string) {
    sel.replaceChildren(option("ERG", ERG));
    for (const t of tokenlist.tokens) {
      const live = store.deepestPool(t.id);
      sel.append(
        option(
          `${t.name || t.id.slice(0, 8)}${live ? `  (${formatUnits(live.box.value, ERG_DECIMALS, 0)} ERG pool)` : ""}`,
          t.id,
        ),
      );
    }
    if (current && current !== ERG && !store.whitelisted(current))
      sel.append(option(`${store.nameOf(current)} (${current.slice(0, 8)}…)`, current));
    sel.append(option("other token…", OTHER));
    sel.value = current;
  }

  function renderSelectors() {
    fillAssetSelect(swapFrom, s.fromId);
    fillAssetSelect(swapTo, s.toId);
    const otherRow = $<HTMLDivElement>("swap-other-row");
    for (const [sel, side] of [
      [swapFrom, "from"],
      [swapTo, "to"],
    ] as const) {
      sel.onchange = () => {
        if (sel.value === OTHER) {
          otherSide = side;
          otherRow.hidden = false;
          return;
        }
        otherRow.hidden = true;
        if (side === "from") s.fromId = sel.value;
        else s.toId = sel.value;
        renderQuote();
        void renderBalance();
      };
    }
  }

  $<HTMLButtonElement>("swap-other-go").onclick = () => {
    const id = $<HTMLInputElement>("swap-other").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) {
      log("a token id is 64 hex characters");
      return;
    }
    if (!store.pooled(id)) {
      log(`no ErgoDEX pool holds token ${id.slice(0, 10)}…`);
      return;
    }
    if (!store.tokens.has(id)) void store.tokenInfo(id).then(() => renderSelectors());
    if (otherSide === "from") s.fromId = id;
    else s.toId = id;
    renderSelectors();
    renderQuote();
    void renderBalance();
  };

  /** The connected wallet's balance of the asset being paid, with a "max" that leaves the fee and a change box. */
  async function renderBalance() {
    const el = $<HTMLDivElement>("swap-balance");
    el.replaceChildren();
    const wallet = store.wallet;
    if (!wallet || !s.fromId) return;
    try {
      const raw = BigInt(await wallet.api.get_balance(s.fromId));
      const reserve = s.fromId === ERG ? FEE + 2_000_000n : 0n; // the fee, the received box, a change box that may carry tokens
      const max = raw > reserve ? raw - reserve : 0n;
      el.append(`balance ${formatUnits(raw, store.decimalsOf(s.fromId))} ${store.nameOf(s.fromId)} `);
      const b = document.createElement("button");
      b.textContent = "max";
      b.onclick = () => {
        swapIn.value = formatUnits(max, store.decimalsOf(s.fromId));
        renderQuote();
      };
      el.append(b);
    } catch (e) {
      el.textContent = `balance: ${err(e)}`;
    }
  }

  function slippageBps(): bigint {
    const t = $<HTMLInputElement>("slippage").value.trim() || "1";
    return parseUnits(t, 2); // percent with two decimals -> basis points
  }

  function renderQuote() {
    const dlEl = $<HTMLDListElement>("swap-quote");
    dlEl.replaceChildren();
    swapGo.disabled = true;
    swapOut.value = "";
    shown = undefined;
    const r = route(store);
    const { fromId, toId } = s;
    $("swap-route").textContent =
      r.kind === "none"
        ? r.why
        : r.kind === "n2t"
          ? `ERG pool, ${formatUnits(r.entry.box.value, ERG_DECIMALS, 0)} ERG deep`
          : `direct ${store.nameOf(fromId)}/${store.nameOf(toId)} pool`;
    if (r.kind === "none") return;
    const inDec = store.decimalsOf(fromId),
      outDec = store.decimalsOf(toId);
    const rows: [string, string][] = [];
    let feeNum: bigint;
    let quoteFn: (amountIn: bigint) => bigint;
    let impactFn: (amountIn: bigint) => bigint;
    if (r.kind === "n2t") {
      const pool = describePool(r.entry.box);
      feeNum = pool.feeNum;
      const tokDec = r.entry.tokenDecimals;
      const spot = pool.y === 0n ? 0n : (pool.x * 10n ** BigInt(tokDec)) / pool.y;
      rows.push([
        "Pool price",
        `${formatUnits(spot, ERG_DECIMALS, 6)} ERG per ${store.nameOf(r.entry.box.assets[2].tokenId)}`,
      ]);
      quoteFn = (a) => quote(pool, r.direction, a);
      impactFn = (a) => priceImpactBps(pool, r.direction, a);
    } else {
      const pool = describeT2TPool(r.entry.box);
      feeNum = pool.feeNum;
      const { reserveIn, reserveOut } = t2tSides(pool, fromId);
      const spot = reserveIn === 0n ? 0n : (reserveOut * 10n ** BigInt(inDec)) / reserveIn; // out units per whole in
      rows.push(["Pool price", `${formatUnits(spot, outDec, 6)} ${store.nameOf(toId)} per ${store.nameOf(fromId)}`]);
      rows.push([
        "Pool reserves",
        `${formatUnits(pool.x, store.decimalsOf(pool.xId))} ${store.nameOf(pool.xId)} and ${formatUnits(pool.y, store.decimalsOf(pool.yId))} ${store.nameOf(pool.yId)}`,
      ]);
      quoteFn = (a) => quoteT2T(pool, fromId, a);
      impactFn = (a) => priceImpactBpsT2T(pool, fromId, a);
    }
    rows.push(["Pool fee", `${formatUnits(1000n - feeNum, 1)}% to liquidity providers`]);
    let amountIn = 0n;
    try {
      if (swapIn.value.trim()) amountIn = parseUnits(swapIn.value, inDec);
    } catch (e) {
      rows.push(["Amount", err(e)]);
    }
    if (amountIn > 0n) {
      const out = quoteFn(amountIn);
      swapOut.value = formatUnits(out, outDec);
      // the bank as the other venue for SigUSD and SigRSV against ERG: shown, never chosen for the user
      const bank = s.bank;
      const bankCoin = coinOf(fromId === ERG ? toId : fromId);
      if (bank && bankCoin && (fromId === ERG || toId === ERG)) {
        try {
          if (fromId === ERG) {
            // the pool gives `out` tokens for amountIn ERG; what would minting `out` tokens cost at the bank?
            const q = mintQuote(bank, bankCoin, out);
            rows.push([
              "Same tokens from the bank",
              q.allowed
                ? `${formatUnits(q.erg, ERG_DECIMALS)} ERG (${q.erg < amountIn ? "cheaper: use the Bank tab" : "dearer"})`
                : "not allowed now",
            ]);
          } else {
            const q = bankRedeemQuote(bank, bankCoin, amountIn);
            rows.push([
              "Same tokens to the bank",
              q.allowed
                ? `${formatUnits(q.erg, ERG_DECIMALS)} ERG (${q.erg > out ? "better: use the Bank tab" : "worse"})`
                : "not allowed now",
            ]);
          }
        } catch {
          /* no bank quote */
        }
      }
      const minOut = out - (out * slippageBps()) / 10_000n;
      shown = { amountIn, minOut };
      rows.push(["You receive (estimate)", `${formatUnits(out, outDec)} ${store.nameOf(toId)}`]);
      rows.push(["Minimum after slippage", formatUnits(minOut, outDec)]);
      rows.push(["Price impact", `${formatUnits(impactFn(amountIn), 2)}%`]);
      rows.push(["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG (the only fee this page adds)`]);
      swapGo.disabled = !store.wallet || out <= 0n;
      swapGo.textContent = store.wallet ? "Swap" : "Connect a wallet to swap";
    }
    dl(dlEl, rows);
  }

  swapIn.oninput = renderQuote;
  $<HTMLInputElement>("slippage").oninput = renderQuote;
  $<HTMLButtonElement>("swap-flip").onclick = () => {
    [s.fromId, s.toId] = [s.toId, s.fromId];
    swapIn.value = "";
    renderSelectors();
    renderQuote();
    void renderBalance();
  };
  swapGo.onclick = async () => {
    try {
      const r = route(store);
      if (r.kind === "none") throw new Error(r.why);
      const amountIn = parseUnits(swapIn.value, store.decimalsOf(s.fromId));
      if (!shown || shown.amountIn !== amountIn) throw new Error("the quote is stale; type the amount again");
      // the pool is re-read now; it must still pay at least the minimum the user saw, or the build refuses
      const minOut = shown.minOut;
      const user = store.wallet!.changeAddress;
      if (r.kind === "n2t") {
        const fresh = await store.explorer.poolByNft(r.entry.box.assets[0].tokenId);
        await send(store, (height, inputs) =>
          buildSwap({ height, inputs, user, poolBox: fresh.box, direction: r.direction, amountIn, minOut }),
        );
      } else {
        const fresh = await store.explorer.t2tPoolByNft(r.entry.box.assets[0].tokenId);
        await send(store, (height, inputs) =>
          buildSwapT2T({ height, inputs, user, poolBox: fresh.box, inId: s.fromId, amountIn, minOut }),
        );
      }
      swapIn.value = "";
      setTimeout(() => {
        void store.loadPools();
        void renderBalance();
      }, 3000);
    } catch (e) {
      log(`swap failed: ${err(e)}`);
    }
  };

  store.subscribe("pools", () => {
    renderSelectors();
    renderQuote();
  });
  store.subscribe("bank", renderQuote);
  store.subscribe("wallet", () => {
    renderQuote();
    void renderBalance();
  });
  return {};
}
