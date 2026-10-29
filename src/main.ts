import type { Box } from "@fleet-sdk/common";
import { buildDeposit, buildRedeem, buildSwap, depositQuote, describePool, lpSupply, priceImpactBps, quote, redeemQuote, type SwapDirection } from "./amm";
import { Explorer, type PoolEntry, type TokenInfo } from "./explorer";
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

// ---- swap --------------------------------------------------------------------------------------

const swapIn = $<HTMLInputElement>("swap-in");
const swapOut = $<HTMLInputElement>("swap-out");
const swapFrom = $<HTMLSelectElement>("swap-from");
const swapTo = $<HTMLSelectElement>("swap-to");
const swapGo = $<HTMLButtonElement>("swap-go");
let direction: SwapDirection = "erg-to-token";
let selectedToken = "";

const OTHER = "__other__";

/** The deepest live pool for a token id, if the explorer listed one. */
function deepestPool(tokenId: string): PoolEntry | undefined {
  return pools.filter((p) => p.box.assets[2].tokenId === tokenId).sort((a, b) => (b.box.value > a.box.value ? 1 : -1))[0];
}

/** Options: the static whitelist (tokens whose deepest pool held 100 ERG or more when the list was made), then "other". */
function tokenSelect(sel: HTMLSelectElement) {
  sel.replaceChildren();
  for (const t of tokenlist.tokens) {
    const live = deepestPool(t.id);
    const o = new Option(`${t.name || t.id.slice(0, 8)}${live ? `  (${formatUnits(live.box.value, ERG_DECIMALS, 0)} ERG pool)` : ""}`, t.id);
    sel.append(o);
  }
  sel.append(new Option("other token…", OTHER));
  if (selectedToken) sel.value = selectedToken;
}

function renderSwapSelectors() {
  // the token side is a select; the ERG side is fixed text
  const tokenSide = direction === "erg-to-token" ? swapTo : swapFrom;
  const ergSide = direction === "erg-to-token" ? swapFrom : swapTo;
  tokenSelect(tokenSide);
  ergSide.replaceChildren(new Option("ERG", "ERG"));
  const otherRow = $<HTMLDivElement>("swap-other-row");
  tokenSide.onchange = () => {
    if (tokenSide.value === OTHER) {
      otherRow.hidden = false;
      return;
    }
    otherRow.hidden = true;
    selectedToken = tokenSide.value;
    renderQuote();
    void renderBalance();
  };
  if (!selectedToken) selectedToken = tokenSide.value;
  void renderBalance();
}

$<HTMLButtonElement>("swap-other-go").onclick = () => {
  const id = $<HTMLInputElement>("swap-other").value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) {
    log("a token id is 64 hex characters");
    return;
  }
  if (!deepestPool(id)) {
    log(`no ErgoDEX v1 ERG pool holds token ${id.slice(0, 10)}…`);
    return;
  }
  selectedToken = id;
  renderQuote();
  void renderBalance();
};

/** The connected wallet's balance of the asset being paid, with a "max" that leaves the fee and a change box. */
async function renderBalance() {
  const el = $<HTMLDivElement>("swap-balance");
  el.replaceChildren();
  const p = selectedPool();
  if (!wallet || !p) return;
  try {
    const pool = describePool(p.box);
    const paying = direction === "erg-to-token" ? "ERG" : pool.tokenId;
    const dec = direction === "erg-to-token" ? ERG_DECIMALS : p.tokenDecimals;
    const raw = BigInt(await wallet.api.get_balance(paying));
    const reserve = direction === "erg-to-token" ? FEE + 1_000_000n : 0n; // fee plus a minimum change box
    const max = raw > reserve ? raw - reserve : 0n;
    el.append(`balance ${formatUnits(raw, dec)} ${direction === "erg-to-token" ? "ERG" : p.tokenName || "tokens"} `);
    const b = document.createElement("button");
    b.textContent = "max";
    b.onclick = () => {
      swapIn.value = formatUnits(max, dec);
      renderQuote();
    };
    el.append(b);
  } catch (e) {
    el.textContent = `balance: ${err(e)}`;
  }
}

function selectedPool(): PoolEntry | undefined {
  return selectedToken ? deepestPool(selectedToken) : undefined;
}

function slippageBps(): bigint {
  const t = $<HTMLInputElement>("slippage").value.trim() || "1";
  return parseUnits(t, 2); // percent with two decimals -> basis points
}

function renderQuote() {
  const dl = $<HTMLDListElement>("swap-quote");
  dl.replaceChildren();
  swapGo.disabled = true;
  const p = selectedPool();
  if (!p) return;
  const pool = describePool(p.box);
  const inDec = direction === "erg-to-token" ? ERG_DECIMALS : p.tokenDecimals;
  const outDec = direction === "erg-to-token" ? p.tokenDecimals : ERG_DECIMALS;
  const name = p.tokenName || pool.tokenId.slice(0, 8);
  const rows: [string, string][] = [];
  const spot = pool.y === 0n ? 0n : (pool.x * 10n ** BigInt(p.tokenDecimals)) / pool.y; // nanoERG per whole token
  rows.push(["Pool price", `${formatUnits(spot, ERG_DECIMALS, 6)} ERG per ${name}`]);
  rows.push(["Pool fee", `${formatUnits(1000n - pool.feeNum, 1)}% to liquidity providers`]);
  let amountIn = 0n;
  try {
    if (swapIn.value.trim()) amountIn = parseUnits(swapIn.value, inDec);
  } catch (e) {
    rows.push(["Amount", err(e)]);
  }
  if (amountIn > 0n) {
    const out = quote(pool, direction, amountIn);
    swapOut.value = formatUnits(out, outDec);
    const minOut = out - (out * slippageBps()) / 10_000n;
    rows.push(["You receive (estimate)", `${formatUnits(out, outDec)} ${direction === "erg-to-token" ? name : "ERG"}`]);
    rows.push(["Minimum after slippage", `${formatUnits(minOut, outDec)}`]);
    rows.push(["Price impact", `${formatUnits(priceImpactBps(pool, direction, amountIn), 2)}%`]);
    rows.push(["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG (the only fee this page adds)`]);
    swapGo.disabled = !wallet || out <= 0n;
    swapGo.textContent = wallet ? "Swap" : "Connect a wallet to swap";
  } else {
    swapOut.value = "";
  }
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

swapIn.oninput = renderQuote;
$<HTMLInputElement>("slippage").oninput = renderQuote;
$<HTMLButtonElement>("swap-flip").onclick = () => {
  direction = direction === "erg-to-token" ? "token-to-erg" : "erg-to-token";
  swapIn.value = "";
  renderSwapSelectors();
  renderQuote();
};
swapGo.onclick = async () => {
  try {
    const p = selectedPool();
    if (!p) throw new Error("pick a token");
    const inDec = direction === "erg-to-token" ? ERG_DECIMALS : p.tokenDecimals;
    const amountIn = parseUnits(swapIn.value, inDec);
    const fresh = await explorer.poolByNft(p.box.assets[0].tokenId); // the pool as it stands now, not as it was listed
    const minOut = (() => {
      const q = quote(describePool(fresh.box), direction, amountIn);
      return q - (q * slippageBps()) / 10_000n;
    })();
    await send((height, inputs) => buildSwap({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, direction, amountIn, minOut }));
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
    pools = (await explorer.pools(500)).sort((a, b) => (b.box.value > a.box.value ? 1 : -1));
    if (!selectedToken) selectedToken = tokenlist.tokens.find((t) => t.name === "SigUSD")?.id ?? tokenlist.tokens[0]?.id ?? "";
    renderSwapSelectors();
    renderQuote();
    renderTokenPick();
    log(`${pools.length} pools listed by the explorer; ${tokenlist.tokens.length} tokens in the static list (${tokenlist.generated})`);
  } catch (e) {
    log(`could not load pools: ${err(e)}`);
  }
}

// ---- pool (liquidity) --------------------------------------------------------------------------

let lpToken = "";

function lpPool(): PoolEntry | undefined {
  return lpToken ? deepestPool(lpToken) : undefined;
}

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

async function renderPool() {
  const sel = $<HTMLSelectElement>("lp-token");
  if (!sel.options.length) {
    for (const t of tokenlist.tokens) sel.append(new Option(t.name || t.id.slice(0, 8), t.id));
    sel.onchange = () => {
      lpToken = sel.value;
      void renderPool();
    };
  }
  if (!lpToken) lpToken = selectedToken || sel.value;
  sel.value = lpToken;
  const p = lpPool();
  if (!p) {
    dl($("lp-info"), [["Pool", "no pool listed for this token yet (the explorer is still loading, or the token has none)"]]);
    return;
  }
  const pool = describePool(p.box);
  const name = p.tokenName || pool.tokenId.slice(0, 8);
  $("lp-tok-name").textContent = name;
  const rows: [string, string][] = [
    ["Reserves", `${formatUnits(pool.x, ERG_DECIMALS, 3)} ERG and ${formatUnits(pool.y, p.tokenDecimals)} ${name}`],
    ["LP in circulation", lpSupply(pool).toString()],
    ["Pool fee", `${formatUnits(1000n - pool.feeNum, 1)}% to liquidity providers`],
  ];
  if (wallet) {
    try {
      const lp = BigInt(await wallet.api.get_balance(pool.lpTokenId));
      const share = redeemQuote(pool, lp);
      rows.push(["Your LP tokens", `${lp} (${formatUnits(share.ergOut, ERG_DECIMALS, 4)} ERG and ${formatUnits(share.tokenOut, p.tokenDecimals)} ${name})`]);
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

function renderDepositQuote() {
  const p = lpPool();
  const btn = $<HTMLButtonElement>("lp-add");
  btn.disabled = true;
  if (!p) return;
  const pool = describePool(p.box);
  try {
    const text = $<HTMLInputElement>("lp-erg").value.trim();
    if (!text) {
      $<HTMLInputElement>("lp-tok").value = "";
      dl($("lp-quote"), []);
      return;
    }
    const ergIn = parseUnits(text, ERG_DECIMALS);
    const q = depositQuote(pool, ergIn);
    $<HTMLInputElement>("lp-tok").value = formatUnits(q.tokenIn, p.tokenDecimals);
    const supply = lpSupply(pool) + q.lpOut;
    dl($("lp-quote"), [
      ["LP tokens you receive", q.lpOut.toString()],
      ["Your share after", `${formatUnits((q.lpOut * 1_000_000n) / supply, 4)}%`],
      ["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG`],
    ]);
    btn.disabled = !wallet || q.lpOut <= 0n;
  } catch (e) {
    dl($("lp-quote"), [["Amount", err(e)]]);
  }
}

function renderRedeemQuote() {
  const p = lpPool();
  const btn = $<HTMLButtonElement>("lp-remove");
  btn.disabled = true;
  if (!p) return;
  const pool = describePool(p.box);
  try {
    const text = $<HTMLInputElement>("lp-in").value.trim();
    if (!text) {
      dl($("lp-redeem-quote"), []);
      return;
    }
    const lpIn = parseUnits(text, 0);
    const q = redeemQuote(pool, lpIn);
    dl($("lp-redeem-quote"), [
      ["You receive", `${formatUnits(q.ergOut, ERG_DECIMALS)} ERG and ${formatUnits(q.tokenOut, p.tokenDecimals)} ${p.tokenName || "tokens"}`],
      ["Miner fee", `${formatUnits(FEE, ERG_DECIMALS)} ERG`],
    ]);
    btn.disabled = !wallet || (q.ergOut <= 0n && q.tokenOut <= 0n);
  } catch (e) {
    dl($("lp-redeem-quote"), [["Amount", err(e)]]);
  }
}

$<HTMLInputElement>("lp-erg").oninput = renderDepositQuote;
$<HTMLInputElement>("lp-in").oninput = renderRedeemQuote;
$<HTMLButtonElement>("lp-add").onclick = async () => {
  try {
    const p = lpPool();
    if (!p) throw new Error("pick a pool");
    const ergIn = parseUnits($<HTMLInputElement>("lp-erg").value, ERG_DECIMALS);
    const fresh = await explorer.poolByNft(p.box.assets[0].tokenId);
    await send((height, inputs) => buildDeposit({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, ergIn }));
    $<HTMLInputElement>("lp-erg").value = "";
    setTimeout(() => void loadPools().then(renderPool), 3000);
  } catch (e) {
    log(`add liquidity failed: ${err(e)}`);
  }
};
$<HTMLButtonElement>("lp-remove").onclick = async () => {
  try {
    const p = lpPool();
    if (!p) throw new Error("pick a pool");
    const lpIn = parseUnits($<HTMLInputElement>("lp-in").value, 0);
    const fresh = await explorer.poolByNft(p.box.assets[0].tokenId);
    await send((height, inputs) => buildRedeem({ height, inputs, user: wallet!.changeAddress, poolBox: fresh.box, lpIn }));
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
