// The LithosDex tab: the ERG/LIT pool and its fee vault, swap and deposit orders, the visitor's open orders (cancel)
// and provisions (claim, redeem order). Orders are executed by the Lithos client's batcher, not by the page. Every
// contract here is ErgoTree version 3: placing an order spends only the visitor's boxes, so any wallet signs it;
// cancelling and claiming spend version-3 boxes, which a wallet signs only if its library reads version 3.
import type { Box } from "@fleet-sdk/common";
import {
  DEFAULT_EXECUTOR_FEE,
  LIT,
  ORDER_KINDS,
  POOL_NFT,
  PROVISION_GUARD_TREE,
  PROVISION_MIN,
  RETURNED,
  VAULT_NFT,
  buildCancel,
  buildClaim,
  buildDepositOrder,
  buildRedeemOrder,
  buildSwapOrder,
  depositShares,
  describeOrder,
  describePool,
  describeProvision,
  describeVault,
  orderTemplateSha256,
  owed,
  quoteSwap,
  redeemShare,
  type OrderView,
  type PoolView,
  type ProvisionView,
  type VaultView,
} from "../protocols/lithos/lithos";
import { FEE } from "../protocols/machina/orders";
import { ERG_DECIMALS, formatUnits, parseUnits } from "../units";
import { ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import { $, dl, err, log, table, td } from "./dom";
import { listing } from "./listing";
import type { Store } from "./store";
import { send } from "./wallet";

/** LIT's decimals (EIP-4 metadata of the token, 9); read from the explorer when it answers. */
const LIT_DECIMALS = 9;
const PROVISION_GUARD_SHA256 = hex.encode(sha256(new ErgoTree(PROVISION_GUARD_TREE).template));

const KIND_LABEL: Record<OrderView["kind"], string> = {
  "swap-sell": "swap ERG for LIT",
  "swap-buy": "swap LIT for ERG",
  deposit: "deposit",
  redeem: "redeem",
};

/** The sentence every cancel and claim shows before the wallet prompt, and the tab's standing note. */
export const V3_NOTE =
  "needs a wallet whose signing library reads ErgoTree version 3 (sigma-rust 0.29 or later); Nautilus 1.4 cannot sign it";

export function mountLithos(store: Store) {
  const state = listing(store, $("lithos-pool-state"), () => void load());
  let pool: { box: Box<bigint>; v: PoolView } | undefined;
  let vault: { box: Box<bigint>; v: VaultView } | undefined;
  let litDecimals = LIT_DECIMALS;
  const erg = (x: bigint) => `${formatUnits(x, ERG_DECIMALS, 6)} ERG`;
  const lit = (x: bigint) => `${formatUnits(x, litDecimals, 4)} LIT`;
  const reload = () => setTimeout(() => void load(), 3000);

  function renderPool() {
    if (!pool) return;
    const p = pool.v;
    const rows: [string, string][] = [
      ["ERG reserve", erg(p.reservesX)],
      ["LIT reserve", lit(p.reservesY)],
      [
        "Price",
        `${formatUnits((p.reservesX * 10n ** BigInt(litDecimals)) / p.reservesY, ERG_DECIMALS, 9)} ERG per LIT`,
      ],
      [
        "Fees",
        `${formatUnits(10_000n - p.feeNum, 2)}% to the pool, ${formatUnits(p.ergFee, 2)}% (ERG in) or ${formatUnits(p.tokenFee, 2)}% (LIT in) to providers`,
      ],
      ["Fees not yet flushed to the vault", `${erg(p.pendingX)}, ${lit(p.pendingY)}`],
    ];
    if (vault) rows.push(["Fee vault", `${erg(vault.v.value)}, ${lit(vault.v.lit)}`]);
    dl($<HTMLDListElement>("lithos-pool"), rows);
    state.done();
    $("lithos-pool-state").textContent = `pool box ${p.boxId.slice(0, 12)}…`;
  }

  function orderRow(box: Box<bigint>, v: OrderView): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const t = v.terms;
    let what = "";
    if (v.kind === "swap-sell") what = `${erg(t.baseAmount!)} for at least ${lit(t.minQuote!)}`;
    if (v.kind === "swap-buy") what = `${lit(v.token?.amount ?? 0n)} for at least ${erg(t.minQuote!)}`;
    if (v.kind === "deposit")
      what = `${erg(t.depositX!)} and ${lit(v.token?.amount ?? 0n)} for at least ${t.minShares} shares`;
    if (v.kind === "redeem") what = `provision of NFT ${v.token?.tokenId.slice(0, 8)}…`;
    tr.append(
      td(KIND_LABEL[v.kind]),
      td(what),
      td(erg(v.value), "num"),
      td(erg(t.executorFee), "num"),
      td(String(v.creationHeight), "num"),
    );
    const actions = document.createElement("td");
    const wallet = store.wallet;
    if (wallet) {
      const b = document.createElement("button");
      b.textContent = "cancel";
      b.onclick = () =>
        send(
          store,
          (h, inputs) => buildCancel({ height: h, inputs, owner: wallet.changeAddress, orderBox: box }),
          `Cancel the LithosDex ${KIND_LABEL[v.kind]} order: ${erg(v.value)}${v.token ? ` and its tokens` : ""} back to you, less the miner fee ${erg(FEE)}; this ${V3_NOTE}`,
        )
          .then(reload)
          .catch((e) => log(`cancel failed: ${err(e)}`));
      actions.append(b);
    }
    tr.append(actions);
    return tr;
  }

  function provisionRow(box: Box<bigint>, pv: ProvisionView): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const share = pool ? redeemShare(pool.v, pv.shares) : undefined;
    const o = vault ? owed(vault.v, pv) : undefined;
    tr.append(
      td(String(pv.shares), "num"),
      td(share ? `${erg(share.x)}, ${lit(share.y)}` : "?"),
      td(o ? (o.claimable ? `${erg(o.x)}, ${lit(o.y)}` : "nothing until the next flush") : "?"),
    );
    const actions = document.createElement("td");
    const wallet = store.wallet;
    if (wallet && vault && o?.claimable) {
      const b = document.createElement("button");
      b.textContent = "claim";
      const v = vault;
      b.onclick = () =>
        send(
          store,
          (h, inputs) =>
            buildClaim({ height: h, inputs, owner: wallet.changeAddress, vaultBox: v.box, provisionBoxes: [box] }),
          `Claim this provision's fees from the vault: ${erg(o.x)} and ${lit(o.y)} to you, miner fee ${erg(FEE)}; this ${V3_NOTE}`,
        )
          .then(reload)
          .catch((e) => log(`claim failed: ${err(e)}`));
      actions.append(b, " ");
    }
    if (wallet) {
      const b = document.createElement("button");
      b.textContent = "redeem order";
      b.onclick = () =>
        send(
          store,
          (h, inputs) => buildRedeemOrder({ height: h, inputs, owner: wallet.changeAddress, provisionBox: box }),
          `Place an order to close this provision (its ownership NFT and ${erg(RETURNED)} into the order, executor fee ${erg(DEFAULT_EXECUTOR_FEE)}, miner fee ${erg(FEE)}); fees not claimed first stay in the vault for good`,
        )
          .then(reload)
          .catch((e) => log(`redeem order failed: ${err(e)}`));
      actions.append(b);
    }
    tr.append(actions);
    return tr;
  }

  async function loadMine() {
    const wallet = store.wallet;
    if (!wallet) {
      $("lithos-orders").textContent = "connect a wallet to see your orders";
      $("lithos-provisions").textContent = "connect a wallet to see your provisions";
      return;
    }
    const orders: { box: Box<bigint>; v: OrderView }[] = [];
    for (const kind of ORDER_KINDS)
      for (const box of await store.explorer.byTemplate(orderTemplateSha256(kind))) {
        const v = describeOrder(box);
        if (v && store.isMine(v.owner)) orders.push({ box, v });
      }
    $("lithos-orders").replaceChildren(
      orders.length
        ? table(
            ["Order", "Terms", "Locked", "Executor fee", "Placed at", ""],
            orders.map(({ box, v }) => orderRow(box, v)),
          )
        : "none",
    );
    const held = new Set((await wallet.utxos()).flatMap((b) => b.assets.map((a) => a.tokenId)));
    const provisions: { box: Box<bigint>; pv: ProvisionView }[] = [];
    for (const box of await store.explorer.byTemplate(PROVISION_GUARD_SHA256, 500)) {
      try {
        const pv = describeProvision(box);
        if (held.has(pv.ownerNft)) provisions.push({ box, pv });
      } catch {
        /* not a provision */
      }
    }
    $("lithos-provisions").replaceChildren(
      provisions.length
        ? table(
            ["Shares", "Redeems for about", "Fees owed", ""],
            provisions.map(({ box, pv }) => provisionRow(box, pv)),
          )
        : "none",
    );
  }

  async function load() {
    state.start();
    try {
      const pb = await store.explorer.latestByToken(POOL_NFT);
      pool = { box: pb, v: describePool(pb) };
      try {
        const vb = await store.explorer.latestByToken(VAULT_NFT);
        vault = { box: vb, v: describeVault(vb) };
      } catch {
        vault = undefined;
      }
      litDecimals = (await store.tokenInfo(LIT)).decimals || LIT_DECIMALS;
      renderPool();
      quote();
      await loadMine();
    } catch (e) {
      state.fail(e);
    }
  }

  // ---- the swap order form ----

  const amountOf = (direction: string) =>
    parseUnits($<HTMLInputElement>("ld-amount").value, direction === "erg-to-lit" ? ERG_DECIMALS : litDecimals);
  const bpsOf = (id = "ld-slippage") => parseUnits($<HTMLInputElement>(id).value || "0", 2);

  function quote() {
    const out = $("ld-quote");
    if (!pool) return void (out.textContent = "");
    try {
      const direction = $<HTMLSelectElement>("ld-direction").value;
      const amountIn = amountOf(direction);
      const q = quoteSwap(pool.v, direction === "erg-to-lit", amountIn);
      if (direction === "erg-to-lit") {
        const min = q - (q * bpsOf()) / 10_000n;
        out.textContent = `the pool would pay ${lit(q)} now; the order asks at least ${lit(min)}. Locked: ${erg(amountIn + DEFAULT_EXECUTOR_FEE + RETURNED)} (the ERG sold, the executor fee ${erg(DEFAULT_EXECUTOR_FEE)}, ${erg(RETURNED)} returned with the fill)`;
      } else {
        const net = q - DEFAULT_EXECUTOR_FEE;
        const min = net - (net * bpsOf()) / 10_000n;
        out.textContent = `the pool would pay ${erg(q)} now, ${erg(net)} after the executor fee; the order asks at least ${erg(min)}. Locked: ${lit(amountIn)} and ${erg(RETURNED)}`;
      }
    } catch {
      out.textContent = "";
    }
  }
  for (const id of ["ld-direction", "ld-amount", "ld-slippage"]) $(id).addEventListener("input", quote);
  $("ld-direction").addEventListener("change", quote);

  $<HTMLFormElement>("ld-swap").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      if (!pool) throw new Error("the pool has not loaded");
      const direction = $<HTMLSelectElement>("ld-direction").value as "erg-to-lit" | "lit-to-erg";
      const amountIn = amountOf(direction);
      const fresh = await store.explorer.latestByToken(POOL_NFT);
      const q = quoteSwap(describePool(fresh), direction === "erg-to-lit", amountIn);
      const net = direction === "erg-to-lit" ? q : q - DEFAULT_EXECUTOR_FEE;
      const minOut = net - (net * bpsOf()) / 10_000n;
      if (minOut <= 0n) throw new Error("too small: the minimum would be nothing after the executor fee");
      const owner = store.wallet!.changeAddress;
      const what =
        direction === "erg-to-lit"
          ? `Place a LithosDex order selling ${erg(amountIn)} for at least ${lit(minOut)}; ${erg(amountIn + DEFAULT_EXECUTOR_FEE + RETURNED)} locked in the order until the executor fills it or you cancel, miner fee ${erg(FEE)}`
          : `Place a LithosDex order selling ${lit(amountIn)} for at least ${erg(minOut)} after the executor fee; ${lit(amountIn)} and ${erg(RETURNED)} locked in the order, miner fee ${erg(FEE)}`;
      await send(
        store,
        (height, inputs) => buildSwapOrder({ height, inputs, owner, poolBox: fresh, direction, amountIn, minOut }),
        what,
      );
      reload();
    } catch (e) {
      log(`order failed: ${err(e)}`);
    }
  };

  // ---- the deposit order form: ERG typed, LIT at the pool's ratio ----

  function depositQuote() {
    const out = $("ld-dep-quote");
    if (!pool) return void (out.textContent = "");
    try {
      const x = parseUnits($<HTMLInputElement>("ld-dep-erg").value, ERG_DECIMALS);
      const y = (x * pool.v.reservesY + pool.v.reservesX - 1n) / pool.v.reservesX;
      const shares = depositShares(pool.v, x, y);
      out.textContent = `with ${lit(y)} at the pool's ratio: about ${shares} shares. Locked: ${erg(x + PROVISION_MIN + DEFAULT_EXECUTOR_FEE + RETURNED)} (of which ${erg(PROVISION_MIN)} becomes the provision box, returned on redemption) and the LIT`;
    } catch {
      out.textContent = "";
    }
  }
  $("ld-dep-erg").addEventListener("input", depositQuote);

  $<HTMLFormElement>("ld-deposit").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const fresh = await store.explorer.latestByToken(POOL_NFT);
      const p = describePool(fresh);
      const amountX = parseUnits($<HTMLInputElement>("ld-dep-erg").value, ERG_DECIMALS);
      const amountY = (amountX * p.reservesY + p.reservesX - 1n) / p.reservesX;
      const shares = depositShares(p, amountX, amountY);
      const minShares = shares - (shares * bpsOf("ld-dep-slippage")) / 10_000n;
      const owner = store.wallet!.changeAddress;
      await send(
        store,
        (height, inputs) => buildDepositOrder({ height, inputs, owner, poolBox: fresh, amountX, amountY, minShares }),
        `Place a LithosDex deposit order: ${erg(amountX)} and ${lit(amountY)} for at least ${minShares} shares; ${erg(amountX + PROVISION_MIN + DEFAULT_EXECUTOR_FEE + RETURNED)} locked, miner fee ${erg(FEE)}`,
      );
      reload();
    } catch (e) {
      log(`deposit order failed: ${err(e)}`);
    }
  };

  store.subscribe("wallet", () => void loadMine().catch((e) => log(`lithos: ${err(e)}`)));
  return { show: () => void load(), load };
}
