import type { Box } from "@fleet-sdk/common";
import {
  buildDeposit, buildDepositT2T, buildRedeem, buildRedeemT2T, buildSwap, buildSwapT2T, depositQuote, depositQuoteFromTokens,
  depositQuoteT2T, depositQuoteT2TFromY, describePool, describeT2TPool, lpSupply, lpSupplyT2T, priceImpactBps, priceImpactBpsT2T,
  quote, quoteT2T, redeemQuote, redeemQuoteT2T, t2tSides, type SwapDirection,
} from "./amm";
import { Explorer, type PoolEntry, type T2TPoolEntry, type TokenInfo } from "./explorer";
import { FEE, buildClose, buildCreate, buildFill, capacity, describe, type OrderView, type OwnerSide } from "./orders";
import { ERG_DECIMALS, ergPerTokenToPrice, formatUnits, parseUnits, priceToErgPerToken } from "./units";
import { availableWallets, connect, disconnect, signAndSubmit, utxos, type Wallet } from "./wallet";
import tokenlist from "./tokenlist.json";

const explorer = new Explorer(import.meta.env.VITE_EXPLORER ?? undefined);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLDivElement>("log");

let wallet: Wallet | undefined;
let orderBoxes: Box<bigint>[] = [];
let pools: PoolEntry[] = [];
const tokens = new Map<string, TokenInfo>();

function log(msg: string) {
  logEl.textContent = `${new Date().toISOString().slice(11, 19)} ${msg}\n` + logEl.textContent;
}
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function tokenInfo(id: string): Promise<TokenInfo> {
  let t = tokens.get(id);
  if (!t) {
    try {
      t = await explorer.token(id);
    } catch {
      t = { id, name: "", decimals: 0 };
    }
    tokens.set(id, t);
  }
  return t;
}

// ---- tabs --------------------------------------------------------------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>("nav [role=tab]")) {
  b.onclick = () => {
    for (const o of document.querySelectorAll<HTMLButtonElement>("nav [role=tab]")) o.setAttribute("aria-selected", String(o === b));
    for (const s of ["swap", "orders", "pool"]) $(`tab-${s}`).hidden = s !== b.dataset.tab;
    if (b.dataset.tab === "pool") renderPool();
  };
}

// ---- wallet ------------------------------------------------------------------------------------

function renderWallet() {
  const el = $<HTMLDivElement>("wallet");
  el.replaceChildren();
  if (wallet) {
    const addr = wallet.changeAddress.encode();
    el.append(`${wallet.name}: ${addr.slice(0, 8)}…${addr.slice(-6)} `);
    const b = document.createElement("button");
    b.textContent = "disconnect";
    b.onclick = async () => {
      await disconnect(wallet!.name);
      wallet = undefined;
      renderWallet();
      renderOrders();
      renderQuote();
      void renderBalance();
    };
    el.append(b);
    return;
  }
  const names = availableWallets();
  if (names.length === 0) {
    el.append("no EIP-12 wallet found (install Nautilus)");
    return;
  }
  for (const name of names) {
    const b = document.createElement("button");
    b.textContent = `connect ${name}`;
    b.onclick = async () => {
      try {
        wallet = await connect(name);
        log(`connected ${name}, change address ${wallet.changeAddress.encode()}`);
      } catch (e) {
        log(`connect failed: ${err(e)}`);
      }
      renderWallet();
      renderOrders();
      renderQuote();
      void renderBalance();
    };
    el.append(b, " ");
  }
}

type Builder = (height: number, inputs: Box<string>[]) => ReturnType<typeof buildCreate>;

async function send(build: Builder): Promise<string> {
  if (!wallet) throw new Error("connect a wallet first");
  const height = await wallet.api.get_current_height();
  const inputs = await utxos(wallet);
  const tx = build(height, inputs);
  log(`built: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs, height ${height}; waiting for the wallet`);
  const txId = await signAndSubmit(wallet, tx);
  log(`submitted ${txId}\n${explorer.txUrl(txId)}`);
  return txId;
}

// ---- assets ------------------------------------------------------------------------------------

const ERG = "ERG";
const OTHER = "__other__";
let t2tPools: T2TPoolEntry[] = [];

function nameOf(id: string): string {
  if (id === ERG) return "ERG";
  return tokens.get(id)?.name || id.slice(0, 8);
}
function decimalsOf(id: string): number {
  if (id === ERG) return ERG_DECIMALS;
  return tokens.get(id)?.decimals ?? 0;
}
function rememberToken(id: string, name: string, decimals: number) {
  if (!tokens.has(id)) tokens.set(id, { id, name, decimals });
}

/** The deepest live ERG pool for a token id, if the explorer listed one. */
function deepestPool(tokenId: string): PoolEntry | undefined {
  return pools.filter((p) => p.box.assets[2].tokenId === tokenId).sort((a, b) => (b.box.value > a.box.value ? 1 : -1))[0];
}

/** The token-to-token pool holding both tokens with the most of `inId`. */
function deepestT2T(inId: string, outId: string): T2TPoolEntry | undefined {
  const has = (e: T2TPoolEntry, id: string) => e.box.assets[2].tokenId === id || e.box.assets[3].tokenId === id;
  return t2tPools
    .filter((e) => has(e, inId) && has(e, outId))
    .sort((a, b) => (t2tSides(describeT2TPool(b.box), inId).reserveIn > t2tSides(describeT2TPool(a.box), inId).reserveIn ? 1 : -1))[0];
}

/** ERG, the whitelist (with the live ERG pool's depth), then "other". */
function fillAssetSelect(sel: HTMLSelectElement, current: string) {
  sel.replaceChildren(new Option("ERG", ERG));
  for (const t of tokenlist.tokens) {
    const live = deepestPool(t.id);
    sel.append(new Option(`${t.name || t.id.slice(0, 8)}${live ? `  (${formatUnits(live.box.value, ERG_DECIMALS, 0)} ERG pool)` : ""}`, t.id));
  }
  if (current && current !== ERG && !tokenlist.tokens.some((t) => t.id === current)) sel.append(new Option(`${nameOf(current)} (${current.slice(0, 8)}…)`, current));
  sel.append(new Option("other token…", OTHER));
  sel.value = current;
}

// ---- swap --------------------------------------------------------------------------------------

const swapIn = $<HTMLInputElement>("swap-in");
const swapOut = $<HTMLInputElement>("swap-out");
const swapFrom = $<HTMLSelectElement>("swap-from");
const swapTo = $<HTMLSelectElement>("swap-to");
const swapGo = $<HTMLButtonElement>("swap-go");
let fromId = ERG;
let toId = "";
let otherSide: "from" | "to" = "to";

type Route =
  | { kind: "n2t"; entry: PoolEntry; direction: SwapDirection }
  | { kind: "t2t"; entry: T2TPoolEntry }
  | { kind: "none"; why: string };

function route(): Route {
  if (!fromId || !toId) return { kind: "none", why: "pick both assets" };
  if (fromId === toId) return { kind: "none", why: "pick two different assets" };
  if (fromId === ERG || toId === ERG) {
    const tokenId = fromId === ERG ? toId : fromId;
    const entry = deepestPool(tokenId);
    if (!entry) return { kind: "none", why: `no ErgoDEX ERG pool holds ${nameOf(tokenId)}` };
    return { kind: "n2t", entry, direction: fromId === ERG ? "erg-to-token" : "token-to-erg" };
  }
  const entry = deepestT2T(fromId, toId);
  if (!entry) return { kind: "none", why: `no direct ${nameOf(fromId)}/${nameOf(toId)} pool: swap to ERG first, then to ${nameOf(toId)}` };
  return { kind: "t2t", entry };
}

function renderSwapSelectors() {
  fillAssetSelect(swapFrom, fromId);
  fillAssetSelect(swapTo, toId);
  const otherRow = $<HTMLDivElement>("swap-other-row");
  for (const [sel, side] of [[swapFrom, "from"], [swapTo, "to"]] as const) {
    sel.onchange = () => {
      if (sel.value === OTHER) {
        otherSide = side;
        otherRow.hidden = false;
        return;
      }
      otherRow.hidden = true;
      if (side === "from") fromId = sel.value;
      else toId = sel.value;
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
  const n2t = deepestPool(id);
  const inT2T = t2tPools.some((e) => e.box.assets[2].tokenId === id || e.box.assets[3].tokenId === id);
  if (!n2t && !inT2T) {
    log(`no ErgoDEX pool holds token ${id.slice(0, 10)}…`);
    return;
  }
  if (!tokens.has(id)) void tokenInfo(id).then(() => renderSwapSelectors());
  if (otherSide === "from") fromId = id;
  else toId = id;
  renderSwapSelectors();
  renderQuote();
  void renderBalance();
};

/** The connected wallet's balance of the asset being paid, with a "max" that leaves the fee and a change box. */
async function renderBalance() {
  const el = $<HTMLDivElement>("swap-balance");
  el.replaceChildren();
  if (!wallet || !fromId) return;
  try {
    const raw = BigInt(await wallet.api.get_balance(fromId));
    const reserve = fromId === ERG ? FEE + 1_000_000n : 0n;
    const max = raw > reserve ? raw - reserve : 0n;
    el.append(`balance ${formatUnits(raw, decimalsOf(fromId))} ${nameOf(fromId)} `);
    const b = document.createElement("button");
    b.textContent = "max";
    b.onclick = () => {
      swapIn.value = formatUnits(max, decimalsOf(fromId));
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
  const r = route();
  $("swap-route").textContent = r.kind === "none" ? r.why : r.kind === "n2t" ? `ERG pool, ${formatUnits(r.entry.box.value, ERG_DECIMALS, 0)} ERG deep` : `direct ${nameOf(fromId)}/${nameOf(toId)} pool`;
  if (r.kind === "none") return;
  const inDec = decimalsOf(fromId), outDec = decimalsOf(toId);
  const rows: [string, string][] = [];
  let feeNum: bigint;
  let quoteFn: (amountIn: bigint) => bigint;
  let impactFn: (amountIn: bigint) => bigint;
  if (r.kind === "n2t") {
    const pool = describePool(r.entry.box);
    feeNum = pool.feeNum;
    const tokDec = r.entry.tokenDecimals;
    const spot = pool.y === 0n ? 0n : (pool.x * 10n ** BigInt(tokDec)) / pool.y;
    rows.push(["Pool price", `${formatUnits(spot, ERG_DECIMALS, 6)} ERG per ${nameOf(r.entry.box.assets[2].tokenId)}`]);
    quoteFn = (a) => quote(pool, r.direction, a);
    impactFn = (a) => priceImpactBps(pool, r.direction, a);
  } else {
    const pool = describeT2TPool(r.entry.box);
    feeNum = pool.feeNum;
    const { reserveIn, reserveOut } = t2tSides(pool, fromId);
    const spot = reserveIn === 0n ? 0n : (reserveOut * 10n ** BigInt(inDec)) / reserveIn; // out units per whole in
    rows.push(["Pool price", `${formatUnits(spot, outDec, 6)} ${nameOf(toId)} per ${nameOf(fromId)}`]);
    rows.push(["Pool reserves", `${formatUnits(pool.x, decimalsOf(pool.xId))} ${nameOf(pool.xId)} and ${formatUnits(pool.y, decimalsOf(pool.yId))} ${nameOf(pool.yId)}`]);
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
    const minOut = out - (out * slippageBps()) / 10_000n;
    rows.push(["You receive (estimate)", `${formatUnits(out, outDec)} ${nameOf(toId)}`]);
    rows.push(["Minimum after slippage", formatUnits(minOut, outDec)]);
    rows.push(["Price impact", `${formatUnits(impactFn(amountIn), 2)}%`]);
    rows.push(["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG (the only fee this page adds)`]);
    swapGo.disabled = !wallet || out <= 0n;
    swapGo.textContent = wallet ? "Swap" : "Connect a wallet to swap";
  }
  dl(dlEl, rows);
}

swapIn.oninput = renderQuote;
$<HTMLInputElement>("slippage").oninput = renderQuote;
$<HTMLButtonElement>("swap-flip").onclick = () => {
  [fromId, toId] = [toId, fromId];
  swapIn.value = "";
  renderSwapSelectors();
  renderQuote();
  void renderBalance();
};
swapGo.onclick = async () => {
  try {
    const r = route();
    if (r.kind === "none") throw new Error(r.why);
    const amountIn = parseUnits(swapIn.value, decimalsOf(fromId));
    const bps = slippageBps();
    if (r.kind === "n2t") {
      const fresh = await explorer.poolByNft(r.entry.box.assets[0].tokenId); // the pool as it stands now
      const q = quote(describePool(fresh.box), r.direction, amountIn);
      const minOut = q - (q * bps) / 10_000n;
      await send((height, inputs) => buildSwap({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, direction: r.direction, amountIn, minOut }));
    } else {
      const fresh = await explorer.t2tPoolByNft(r.entry.box.assets[0].tokenId);
      const q = quoteT2T(describeT2TPool(fresh.box), fromId, amountIn);
      const minOut = q - (q * bps) / 10_000n;
      await send((height, inputs) => buildSwapT2T({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, inId: fromId, amountIn, minOut }));
    }
    swapIn.value = "";
    setTimeout(() => {
      void loadPools();
      void renderBalance();
    }, 3000);
  } catch (e) {
    log(`swap failed: ${err(e)}`);
  }
};

async function loadPools() {
  try {
    [pools, t2tPools] = await Promise.all([explorer.pools(500), explorer.t2tPools(500)]);
    pools.sort((a, b) => (b.box.value > a.box.value ? 1 : -1));
    for (const p of pools) rememberToken(p.box.assets[2].tokenId, p.tokenName, p.tokenDecimals);
    for (const e of t2tPools) {
      rememberToken(e.box.assets[2].tokenId, e.xName, e.xDecimals);
      rememberToken(e.box.assets[3].tokenId, e.yName, e.yDecimals);
    }
    if (!toId) toId = tokenlist.tokens.find((t) => t.name === "SigUSD")?.id ?? tokenlist.tokens[0]?.id ?? "";
    renderSwapSelectors();
    renderQuote();
    renderTokenPick();
    renderPairSelect();
    log(`${pools.length} ERG pools and ${t2tPools.length} token-to-token pools listed by the explorer; ${tokenlist.tokens.length} tokens in the static list (${tokenlist.generated})`);
  } catch (e) {
    log(`could not load pools: ${err(e)}`);
  }
}

// ---- pool (liquidity) --------------------------------------------------------------------------

type Pair = { kind: "n2t"; tokenId: string } | { kind: "t2t"; nft: string };
let pair: Pair | undefined;
let lpSideTyped: "a" | "b" = "a";

function dl(el: HTMLDListElement, rows: [string, string][]) {
  el.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    el.append(dt, dd);
  }
}

const whitelisted = (id: string) => tokenlist.tokens.some((t) => t.id === id);

/** Pairs: ERG with each whitelisted token, then token-to-token pools whose two tokens are both whitelisted. */
function renderPairSelect() {
  const sel = $<HTMLSelectElement>("lp-token");
  const current = sel.value;
  sel.replaceChildren();
  for (const t of tokenlist.tokens) sel.append(new Option(`ERG / ${t.name || t.id.slice(0, 8)}`, `n2t:${t.id}`));
  for (const e of t2tPools) {
    const x = e.box.assets[2].tokenId, y = e.box.assets[3].tokenId;
    if (whitelisted(x) && whitelisted(y)) sel.append(new Option(`${nameOf(x)} / ${nameOf(y)}`, `t2t:${e.box.assets[0].tokenId}`));
  }
  if (current) sel.value = current;
  sel.onchange = () => {
    const [kind, id] = sel.value.split(":");
    pair = kind === "n2t" ? { kind: "n2t", tokenId: id } : { kind: "t2t", nft: id };
    $<HTMLInputElement>("lp-erg").value = "";
    $<HTMLInputElement>("lp-tok").value = "";
    void renderPool();
  };
}

/** The two sides of the selected pair: [a, b] asset ids, and the live pool. */
function pairSides(): { a: string; b: string; n2t?: PoolEntry; t2t?: T2TPoolEntry } | undefined {
  if (!pair) return undefined;
  if (pair.kind === "n2t") {
    const n2t = deepestPool(pair.tokenId);
    return n2t ? { a: ERG, b: pair.tokenId, n2t } : undefined;
  }
  const nft = pair.nft;
  const t2t = t2tPools.find((e) => e.box.assets[0].tokenId === nft);
  return t2t ? { a: t2t.box.assets[2].tokenId, b: t2t.box.assets[3].tokenId, t2t } : undefined;
}

async function renderPool() {
  const sel = $<HTMLSelectElement>("lp-token");
  if (!pair) {
    if (!sel.value) return;
    const [kind, id] = sel.value.split(":");
    pair = kind === "n2t" ? { kind: "n2t", tokenId: id } : { kind: "t2t", nft: id };
  }
  const ps = pairSides();
  if (!ps) {
    dl($("lp-info"), [["Pool", "no pool listed for this pair yet (the explorer is still loading, or the pair has none)"]]);
    return;
  }
  $("lp-erg-name").textContent = nameOf(ps.a);
  $("lp-tok-name").textContent = nameOf(ps.b);
  const rows: [string, string][] = [];
  let lpTokenId: string, feeNum: bigint, supply: bigint;
  let share: (lp: bigint) => [bigint, bigint];
  if (ps.n2t) {
    const pool = describePool(ps.n2t.box);
    lpTokenId = pool.lpTokenId; feeNum = pool.feeNum; supply = lpSupply(pool);
    rows.push(["Reserves", `${formatUnits(pool.x, ERG_DECIMALS, 3)} ERG and ${formatUnits(pool.y, decimalsOf(ps.b))} ${nameOf(ps.b)}`]);
    share = (lp) => { const q = redeemQuote(pool, lp); return [q.ergOut, q.tokenOut]; };
  } else {
    const pool = describeT2TPool(ps.t2t!.box);
    lpTokenId = pool.lpTokenId; feeNum = pool.feeNum; supply = lpSupplyT2T(pool);
    rows.push(["Reserves", `${formatUnits(pool.x, decimalsOf(ps.a))} ${nameOf(ps.a)} and ${formatUnits(pool.y, decimalsOf(ps.b))} ${nameOf(ps.b)}`]);
    share = (lp) => { const q = redeemQuoteT2T(pool, lp); return [q.xOut, q.yOut]; };
  }
  rows.push(["LP in circulation", supply.toString()]);
  rows.push(["Pool fee", `${formatUnits(1000n - feeNum, 1)}% to liquidity providers`]);
  if (wallet) {
    try {
      const lp = BigInt(await wallet.api.get_balance(lpTokenId));
      const [sa, sb] = share(lp);
      rows.push(["Your LP tokens", `${lp} (${formatUnits(sa, decimalsOf(ps.a), 4)} ${nameOf(ps.a)} and ${formatUnits(sb, decimalsOf(ps.b))} ${nameOf(ps.b)})`]);
      $<HTMLButtonElement>("lp-max").onclick = () => {
        $<HTMLInputElement>("lp-in").value = lp.toString();
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

/** Returns [aIn, bIn, lpOut] for the typed side, deriving the other at the pool's ratio. */
function depositAmounts(ps: NonNullable<ReturnType<typeof pairSides>>, typedText: string): [bigint, bigint, bigint] {
  if (ps.n2t) {
    const pool = describePool(ps.n2t.box);
    if (lpSideTyped === "a") {
      const ergIn = parseUnits(typedText, ERG_DECIMALS);
      const q = depositQuote(pool, ergIn);
      return [ergIn, q.tokenIn, q.lpOut];
    }
    const tokenIn = parseUnits(typedText, decimalsOf(ps.b));
    const q = depositQuoteFromTokens(pool, tokenIn);
    return [q.ergIn, tokenIn, q.lpOut];
  }
  const pool = describeT2TPool(ps.t2t!.box);
  if (lpSideTyped === "a") {
    const xIn = parseUnits(typedText, decimalsOf(ps.a));
    const q = depositQuoteT2T(pool, xIn);
    return [xIn, q.yIn, q.lpOut];
  }
  const yIn = parseUnits(typedText, decimalsOf(ps.b));
  const q = depositQuoteT2TFromY(pool, yIn);
  return [q.xIn, yIn, q.lpOut];
}

function renderDepositQuote() {
  const btn = $<HTMLButtonElement>("lp-add");
  btn.disabled = true;
  const ps = pairSides();
  if (!ps) return;
  const aEl = $<HTMLInputElement>("lp-erg");
  const bEl = $<HTMLInputElement>("lp-tok");
  try {
    const typed = (lpSideTyped === "a" ? aEl : bEl).value.trim();
    if (!typed) {
      (lpSideTyped === "a" ? bEl : aEl).value = "";
      dl($("lp-quote"), []);
      return;
    }
    const [aIn, bIn, lpOut] = depositAmounts(ps, typed);
    if (lpSideTyped === "a") bEl.value = formatUnits(bIn, decimalsOf(ps.b));
    else aEl.value = formatUnits(aIn, decimalsOf(ps.a));
    const supply = (ps.n2t ? lpSupply(describePool(ps.n2t.box)) : lpSupplyT2T(describeT2TPool(ps.t2t!.box))) + lpOut;
    dl($("lp-quote"), [
      ["LP tokens you receive", lpOut.toString()],
      ["Your share after", `${formatUnits((lpOut * 1_000_000n) / supply, 4)}%`],
      ["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG`],
    ]);
    btn.disabled = !wallet || lpOut <= 0n;
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
    const text = $<HTMLInputElement>("lp-in").value.trim();
    if (!text) {
      dl($("lp-redeem-quote"), []);
      return;
    }
    const lpIn = parseUnits(text, 0);
    const [a, b] = ps.n2t
      ? (() => { const q = redeemQuote(describePool(ps.n2t!.box), lpIn); return [q.ergOut, q.tokenOut]; })()
      : (() => { const q = redeemQuoteT2T(describeT2TPool(ps.t2t!.box), lpIn); return [q.xOut, q.yOut]; })();
    dl($("lp-redeem-quote"), [
      ["You receive", `${formatUnits(a, decimalsOf(ps.a))} ${nameOf(ps.a)} and ${formatUnits(b, decimalsOf(ps.b))} ${nameOf(ps.b)}`],
      ["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG`],
    ]);
    btn.disabled = !wallet || (a <= 0n && b <= 0n);
  } catch (e) {
    dl($("lp-redeem-quote"), [["Amount", err(e)]]);
  }
}

$<HTMLInputElement>("lp-erg").oninput = () => {
  lpSideTyped = "a";
  renderDepositQuote();
};
$<HTMLInputElement>("lp-tok").oninput = () => {
  lpSideTyped = "b";
  renderDepositQuote();
};
$<HTMLInputElement>("lp-in").oninput = renderRedeemQuote;
$<HTMLButtonElement>("lp-add").onclick = async () => {
  try {
    const ps = pairSides();
    if (!ps) throw new Error("pick a pair");
    const typed = (lpSideTyped === "a" ? $<HTMLInputElement>("lp-erg") : $<HTMLInputElement>("lp-tok")).value;
    if (ps.n2t) {
      const fresh = await explorer.poolByNft(ps.n2t.box.assets[0].tokenId);
      const [ergIn] = depositAmounts({ ...ps, n2t: fresh }, typed);
      await send((height, inputs) => buildDeposit({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, ergIn }));
    } else {
      const fresh = await explorer.t2tPoolByNft(ps.t2t!.box.assets[0].tokenId);
      const [xIn] = depositAmounts({ ...ps, t2t: fresh }, typed);
      await send((height, inputs) => buildDepositT2T({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, xIn }));
    }
    $<HTMLInputElement>("lp-erg").value = "";
    $<HTMLInputElement>("lp-tok").value = "";
    setTimeout(() => void loadPools().then(renderPool), 3000);
  } catch (e) {
    log(`add liquidity failed: ${err(e)}`);
  }
};
$<HTMLButtonElement>("lp-remove").onclick = async () => {
  try {
    const ps = pairSides();
    if (!ps) throw new Error("pick a pair");
    const lpIn = parseUnits($<HTMLInputElement>("lp-in").value, 0);
    if (ps.n2t) {
      const fresh = await explorer.poolByNft(ps.n2t.box.assets[0].tokenId);
      await send((height, inputs) => buildRedeem({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, lpIn }));
    } else {
      const fresh = await explorer.t2tPoolByNft(ps.t2t!.box.assets[0].tokenId);
      await send((height, inputs) => buildRedeemT2T({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, lpIn }));
    }
    $<HTMLInputElement>("lp-in").value = "";
    setTimeout(() => void loadPools().then(renderPool), 3000);
  } catch (e) {
    log(`remove liquidity failed: ${err(e)}`);
  }
};

// ---- limit orders ------------------------------------------------------------------------------

function isMine(v: OrderView): boolean {
  return !!wallet && wallet.usedAddresses.includes(v.owner);
}

async function loadOrders() {
  try {
    orderBoxes = await explorer.limitOrders(200);
    await Promise.all([...new Set(orderBoxes.map((b) => describe(b).tokenId))].map(tokenInfo));
    renderOrders();
  } catch (e) {
    $("orders").textContent = `could not load orders: ${err(e)}`;
  }
}

function orderRow(box: Box<bigint>, v: OrderView, decimals: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  if (isMine(v)) tr.className = "mine";
  const cap = capacity(v);
  tr.innerHTML =
    `<td class="num">${priceToErgPerToken(v.price, decimals)}</td>` +
    `<td class="num">${formatUnits(cap, decimals)}${v.takerAction === "sell" ? ` (${formatUnits(v.value, ERG_DECIMALS)} ERG)` : ""}</td>` +
    `<td><code title="${v.owner}">${v.owner.slice(0, 6)}…</code>${isMine(v) ? " (you)" : ""}</td>`;
  const actions = document.createElement("td");
  if (wallet) {
    if (isMine(v)) {
      const b = document.createElement("button");
      b.textContent = "close";
      b.onclick = () =>
        send((height, inputs) => buildClose({ height, inputs, owner: wallet!.changeAddress, orderBox: box }))
          .then(() => setTimeout(() => void loadOrders(), 3000))
          .catch((e) => log(`close failed: ${err(e)}`));
      actions.append(b);
    } else {
      const amount = document.createElement("input");
      amount.size = 10;
      amount.placeholder = formatUnits(cap, decimals);
      const b = document.createElement("button");
      b.textContent = v.takerAction === "buy" ? "buy" : "sell";
      b.onclick = () => {
        try {
          const n = parseUnits(amount.value || amount.placeholder, decimals);
          void send((height, inputs) => buildFill({ height, inputs, taker: wallet!.changeAddress, orderBox: box, tokenAmount: n }))
            .then(() => setTimeout(() => void loadOrders(), 3000))
            .catch((e) => log(`fill failed: ${err(e)}`));
        } catch (e) {
          log(`fill: ${err(e)}`);
        }
      };
      actions.append(amount, " ", b);
    }
  }
  tr.append(actions);
  return tr;
}

function sideTable(title: string, rows: { box: Box<bigint>; v: OrderView }[], decimals: number): HTMLElement[] {
  if (rows.length === 0) return [];
  const h = document.createElement("h3");
  h.textContent = title;
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Price (ERG/token)</th><th>Available</th><th>Owner</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const { box, v } of rows) tbody.append(orderRow(box, v, decimals));
  table.append(tbody);
  return [h, table];
}

/** Grouped by token, one collapsible block each; inside, takers' buys cheapest first and takers' sells dearest first. */
function renderOrders() {
  const groups = new Map<string, { box: Box<bigint>; v: OrderView }[]>();
  for (const box of orderBoxes) {
    try {
      const v = describe(box);
      (groups.get(v.tokenId) ?? groups.set(v.tokenId, []).get(v.tokenId)!).push({ box, v });
    } catch {
      /* a box under the template that the SDK rejects (malformed registers): skip */
    }
  }
  const out: HTMLElement[] = [];
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [tokenId, rows] of sorted) {
    const t = tokens.get(tokenId) ?? { id: tokenId, name: "", decimals: 0 };
    const buys = rows.filter((r) => r.v.takerAction === "buy").sort((a, b) => (a.v.price < b.v.price ? -1 : 1));
    const sells = rows.filter((r) => r.v.takerAction === "sell").sort((a, b) => (a.v.price > b.v.price ? -1 : 1));
    const det = document.createElement("details");
    if (rows.some((r) => isMine(r.v))) det.open = true;
    const sum = document.createElement("summary");
    const best: string[] = [];
    if (buys.length) best.push(`buy from ${priceToErgPerToken(buys[0].v.price, t.decimals)}`);
    if (sells.length) best.push(`sell at ${priceToErgPerToken(sells[0].v.price, t.decimals)}`);
    sum.innerHTML = `${t.name || tokenId.slice(0, 10)} <span class="muted">${rows.length} order${rows.length === 1 ? "" : "s"}; best: ${best.join(", ")} ERG/token</span>`;
    det.append(sum, ...sideTable("You buy tokens from these orders", buys, t.decimals), ...sideTable("You sell tokens into these orders", sells, t.decimals));
    out.push(det);
  }
  $("orders").replaceChildren(...(out.length ? out : ["no open orders"]));
}

/** The create form's token list: the static whitelist; the id field stays editable for any other token. */
function renderTokenPick() {
  const sel = $<HTMLSelectElement>("token-pick");
  sel.replaceChildren(new Option("other (type the id below)", ""));
  for (const t of tokenlist.tokens) {
    sel.append(new Option(t.name || t.id.slice(0, 10), t.id));
    tokens.set(t.id, { id: t.id, name: t.name, decimals: t.decimals });
  }
  sel.onchange = () => {
    $<HTMLInputElement>("token").value = sel.value;
  };
}

$<HTMLSelectElement>("side").onchange = () => {
  $("amount-label").textContent = $<HTMLSelectElement>("side").value === "sell-tokens" ? "Token amount" : "ERG to spend";
};

$<HTMLFormElement>("create").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const side = $<HTMLSelectElement>("side").value as OwnerSide;
    const tokenId = $<HTMLInputElement>("token").value.trim().toLowerCase();
    const t = await tokenInfo(tokenId);
    const price = ergPerTokenToPrice($<HTMLInputElement>("price").value, t.decimals);
    const amountText = $<HTMLInputElement>("amount").value;
    const params = side === "sell-tokens" ? { tokenAmount: parseUnits(amountText, t.decimals) } : { ergAmount: parseUnits(amountText, ERG_DECIMALS) };
    log(`${side} ${t.name || tokenId.slice(0, 10)} at ${price} nanoERG per unit`);
    await send((height, inputs) => buildCreate({ height, inputs, owner: wallet!.changeAddress, side, quoteTokenId: tokenId, price, ...params }));
    setTimeout(() => void loadOrders(), 3000);
  } catch (e) {
    log(`create failed: ${err(e)}`);
  }
};

// ---- boot --------------------------------------------------------------------------------------

renderWallet();
void loadPools();
void loadOrders();
explorer.height().then((h) => log(`explorer ${explorer.base}, height ${h}`)).catch((e) => log(`explorer: ${err(e)}`));
