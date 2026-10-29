import type { Box } from "@fleet-sdk/common";
import { Explorer, type TokenInfo } from "./explorer";
import { buildClose, buildCreate, buildFill, capacity, describe, type OrderView, type OwnerSide } from "./orders";
import { availableWallets, connect, disconnect, signAndSubmit, utxos, type Wallet } from "./wallet";

const explorer = new Explorer(import.meta.env.VITE_EXPLORER ?? undefined);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLDivElement>("log");

let wallet: Wallet | undefined;
let orderBoxes: Box<bigint>[] = [];
const tokens = new Map<string, TokenInfo>();

function log(msg: string) {
  logEl.textContent = `${new Date().toISOString().slice(11, 19)} ${msg}\n` + logEl.textContent;
}

// ---- amounts -----------------------------------------------------------------------------------

function parseUnits(text: string, decimals: number): bigint {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2])) throw new Error(`not a number: "${text}"`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals`);
  return BigInt((m[1] || "0") + frac);
}

function formatUnits(x: bigint, decimals: number): string {
  if (decimals === 0) return x.toString();
  const s = x.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
}

const ERG_DECIMALS = 9;

/** price register (nanoERG per smallest unit) to ERG per whole token */
function priceToErgPerToken(price: bigint, decimals: number): string {
  // ERG/token = price * 10^decimals / 10^9
  const scaled = price * 10n ** BigInt(decimals);
  return formatUnits(scaled, ERG_DECIMALS);
}

/** ERG per whole token to the price register */
function ergPerTokenToPrice(text: string, decimals: number): bigint {
  const nano = parseUnits(text, ERG_DECIMALS); // nanoERG per whole token
  const unitsPerToken = 10n ** BigInt(decimals);
  if (nano % unitsPerToken !== 0n)
    throw new Error(`price must be a multiple of ${formatUnits(unitsPerToken, ERG_DECIMALS)} ERG per token (nanoERG per smallest unit is an integer)`);
  return nano / unitsPerToken;
}

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
        log(`connect failed: ${(e as Error).message}`);
      }
      renderWallet();
      renderOrders();
    };
    el.append(b, " ");
  }
}

async function send(build: (height: number, inputs: Box<string>[]) => ReturnType<typeof buildCreate>) {
  if (!wallet) throw new Error("connect a wallet first");
  const height = await wallet.api.get_current_height();
  const inputs = await utxos(wallet);
  const tx = build(height, inputs);
  log(`built: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs, height ${height}; waiting for the wallet`);
  const txId = await signAndSubmit(wallet, tx);
  log(`submitted ${txId}\n${explorer.txUrl(txId)}`);
  setTimeout(() => void loadOrders(), 3000);
}

// ---- orders ------------------------------------------------------------------------------------

function isMine(v: OrderView): boolean {
  return !!wallet && wallet.usedAddresses.includes(v.owner);
}

async function loadOrders() {
  try {
    orderBoxes = await explorer.limitOrders(200);
    await Promise.all([...new Set(orderBoxes.map((b) => describe(b).tokenId))].map(tokenInfo));
    renderOrders();
  } catch (e) {
    $("orders").textContent = `could not load orders: ${(e as Error).message}`;
  }
}

function renderOrders() {
  const views: { box: Box<bigint>; v: OrderView }[] = [];
  for (const box of orderBoxes) {
    try {
      views.push({ box, v: describe(box) });
    } catch {
      /* a box under the template that the SDK rejects (malformed registers): skip */
    }
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Token</th><th>Takers</th><th>Price (ERG/token)</th><th>Available</th><th>Owner</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const { box, v } of views) {
    const t = tokens.get(v.tokenId) ?? { id: v.tokenId, name: "", decimals: 0 };
    const tr = document.createElement("tr");
    if (isMine(v)) tr.className = "mine";
    const cap = capacity(v);
    tr.innerHTML =
      `<td><code title="${v.tokenId}">${t.name || v.tokenId.slice(0, 10)}</code></td>` +
      `<td>${v.takerAction === "buy" ? "buy tokens" : "sell tokens"}</td>` +
      `<td class="num">${priceToErgPerToken(v.price, t.decimals)}</td>` +
      `<td class="num">${formatUnits(cap, t.decimals)}${v.takerAction === "sell" ? ` (${formatUnits(v.value, ERG_DECIMALS)} ERG)` : ""}</td>` +
      `<td><code title="${v.owner}">${v.owner.slice(0, 6)}…</code>${isMine(v) ? " (you)" : ""}</td>`;
    const actions = document.createElement("td");
    if (wallet) {
      if (isMine(v)) {
        const b = document.createElement("button");
        b.textContent = "close";
        b.onclick = () =>
          send((height, inputs) => buildClose({ height, inputs, owner: wallet!.changeAddress, orderBox: box })).catch((e) =>
            log(`close failed: ${(e as Error).message}`),
          );
        actions.append(b);
      } else {
        const amount = document.createElement("input");
        amount.size = 10;
        amount.placeholder = formatUnits(cap, t.decimals);
        const b = document.createElement("button");
        b.textContent = v.takerAction === "buy" ? "buy" : "sell";
        b.onclick = () => {
          try {
            const n = parseUnits(amount.value || amount.placeholder, t.decimals);
            void send((height, inputs) => buildFill({ height, inputs, taker: wallet!.changeAddress, orderBox: box, tokenAmount: n })).catch(
              (e) => log(`fill failed: ${(e as Error).message}`),
            );
          } catch (e) {
            log(`fill: ${(e as Error).message}`);
          }
        };
        actions.append(amount, " ", b);
      }
    }
    tr.append(actions);
    tbody.append(tr);
  }
  table.append(tbody);
  $("orders").replaceChildren(views.length ? table : "no open orders");
}

// ---- create ------------------------------------------------------------------------------------

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
    const params =
      side === "sell-tokens"
        ? { tokenAmount: parseUnits(amountText, t.decimals) }
        : { ergAmount: parseUnits(amountText, ERG_DECIMALS) };
    log(`${side} ${t.name || tokenId.slice(0, 10)} at ${price} nanoERG per unit`);
    await send((height, inputs) =>
      buildCreate({ height, inputs, owner: wallet!.changeAddress, side, quoteTokenId: tokenId, price, ...params }),
    );
  } catch (e) {
    log(`create failed: ${(e as Error).message}`);
  }
};

// ---- boot --------------------------------------------------------------------------------------

renderWallet();
void loadOrders();
explorer.height().then((h) => log(`explorer ${explorer.base}, height ${h}`)).catch((e) => log(`explorer: ${(e as Error).message}`));
