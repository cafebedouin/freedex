// The Escrow tab: TokenJay's escrow contract. The visitor's own escrows first (with their actions), then every
// other open escrow on the contract, which only its named buyer or seller can act on.
import type { Box } from "@fleet-sdk/common";
import { ErgoAddress, ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import {
  ESCROW_TREE,
  buildCancelEscrow,
  buildCreateEscrow,
  buildTakeEscrow,
  describeEscrow,
  type EscrowView,
} from "../escrow";
import { ERG_DECIMALS, formatUnits, parseUnits } from "../units";
import { $, err, log, table, td, tdCode } from "./dom";
import type { Store } from "./store";
import { send } from "./wallet";

export const ESCROW_TEMPLATE_SHA256 = hex.encode(sha256(new ErgoTree(ESCROW_TREE).template));

type Row = { box: Box<bigint>; v: EscrowView };

export function mountEscrow(store: Store) {
  const reload = () => setTimeout(() => void loadEscrows(), 3000);

  function row({ box, v }: Row): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const seller = store.isMine(v.seller),
      buyer = store.isMine(v.buyer);
    if (seller || buyer) tr.className = "mine";
    tr.append(
      td(`${formatUnits(v.amount, store.decimalsOf(v.tokenId))} ${store.nameOf(v.tokenId)}`),
      td(`${formatUnits(v.price, ERG_DECIMALS)} ERG`, "num"),
      tdCode(v.seller, `${v.seller.slice(0, 6)}…`, seller ? " (you)" : ""),
      tdCode(v.buyer, `${v.buyer.slice(0, 6)}…`, buyer ? " (you)" : ""),
    );
    const actions = document.createElement("td");
    const wallet = store.wallet;
    if (wallet && buyer) {
      const b = document.createElement("button");
      b.textContent = "pay and take";
      b.onclick = () =>
        send(store, (h, inputs) => buildTakeEscrow({ height: h, inputs, buyer: wallet.changeAddress, escrowBox: box }))
          .then(reload)
          .catch((e) => log(`take failed: ${err(e)}`));
      actions.append(b, " ");
    }
    if (wallet && seller) {
      const b = document.createElement("button");
      b.textContent = "cancel";
      b.onclick = () =>
        send(store, (h, inputs) =>
          buildCancelEscrow({ height: h, inputs, seller: wallet.changeAddress, escrowBox: box }),
        )
          .then(reload)
          .catch((e) => log(`cancel failed: ${err(e)}`));
      actions.append(b);
    }
    tr.append(actions);
    return tr;
  }

  const HEADS = ["Tokens", "Price", "Seller", "Buyer", ""];

  async function loadEscrows() {
    try {
      const all: Row[] = (await store.explorer.byTemplate(ESCROW_TEMPLATE_SHA256)).flatMap((box) => {
        try {
          return [{ box, v: describeEscrow(box) }];
        } catch {
          return [];
        }
      });
      for (const { v } of all) if (!store.tokens.has(v.tokenId)) await store.tokenInfo(v.tokenId);
      const mine = all.filter(({ v }) => store.isMine(v.seller) || store.isMine(v.buyer));
      const others = all.filter((r) => !mine.includes(r));
      $("escrow-mine").replaceChildren(
        !store.wallet ? "connect a wallet to see your escrows" : mine.length ? table(HEADS, mine.map(row)) : "none",
      );
      $("escrow-list").replaceChildren(
        others.length ? table(HEADS, others.map(row)) : "no other open escrows on the contract",
      );
    } catch (e) {
      $("escrow-list").textContent = `could not load: ${err(e)}`;
    }
  }

  $<HTMLFormElement>("create-escrow").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const buyer = ErgoAddress.fromBase58($<HTMLInputElement>("esc-buyer").value.trim());
      const tokenId = $<HTMLInputElement>("esc-token").value.trim().toLowerCase();
      const t = await store.tokenInfo(tokenId);
      const amount = parseUnits($<HTMLInputElement>("esc-amount").value, t.decimals);
      const price = parseUnits($<HTMLInputElement>("esc-price").value, ERG_DECIMALS);
      const seller = store.wallet!.changeAddress;
      await send(store, (height, inputs) =>
        buildCreateEscrow({ height, inputs, seller, buyer, tokenId, amount, price }),
      );
      reload();
    } catch (e) {
      log(`escrow failed: ${err(e)}`);
    }
  };

  return { show: () => void loadEscrows() };
}
