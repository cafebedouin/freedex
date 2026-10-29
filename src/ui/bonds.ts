// The Bonds tab: SigmaFi loans on their deployed contracts. The visitor's own positions first, then the market.
import type { Box } from "@fleet-sdk/common";
import {
  SIGMAFI_TEMPLATES,
  buildCancelOrder,
  buildLend,
  buildLiquidate,
  buildOpenOrder,
  buildRepay,
  describeBond,
  describeOrder,
  devFee,
  type BondView,
  type LoanView,
} from "../bonds";
import tokenlist from "../tokenlist.json" with { type: "json" };
import { ERG_DECIMALS, formatUnits, parseUnits } from "../units";
import { $, err, h, log, table, td, tdCode, option } from "./dom";
import { ERG, type Store } from "./store";
import { send } from "./wallet";

type OrderRow = { box: Box<bigint>; v: LoanView };
type BondRow = { box: Box<bigint>; v: BondView };

export function mountBonds(store: Store) {
  const amountText = (id: string, units: bigint) => `${formatUnits(units, store.decimalsOf(id))} ${store.nameOf(id)}`;

  function collateralText(v: LoanView): string {
    const parts: string[] = [];
    if (v.collateralErg > 0n) parts.push(amountText(ERG, v.collateralErg));
    for (const t of v.collateralTokens) parts.push(amountText(t.tokenId, t.amount));
    return parts.join(" + ") || "none";
  }

  const reload = () => setTimeout(() => void loadBonds(), 3000);

  function orderRow({ box, v }: OrderRow): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const mine = store.isMine(v.borrower);
    if (mine) tr.className = "mine";
    const interest = v.principal > 0n ? Number(((v.repayment - v.principal) * 10_000n) / v.principal) / 100 : 0;
    tr.append(
      td(amountText(v.principalId, v.principal)),
      td(`${amountText(v.principalId, v.repayment)} (${interest}%)`),
      td(`${v.term} blocks`, "num"),
      td(collateralText(v)),
      tdCode(v.borrower, `${v.borrower.slice(0, 6)}…`, mine ? " (you)" : ""),
    );
    const actions = document.createElement("td");
    const wallet = store.wallet;
    if (wallet) {
      const b = document.createElement("button");
      b.textContent = mine ? "cancel" : `lend (+${amountText(v.principalId, devFee(v.principal))} dev fee)`;
      b.onclick = () =>
        send(store, (height, inputs) =>
          mine
            ? buildCancelOrder({ height, inputs, borrower: wallet.changeAddress, orderBox: box })
            : buildLend({ height, inputs, lender: wallet.changeAddress, orderBox: box }),
        )
          .then(reload)
          .catch((e) => log(`${mine ? "cancel" : "lend"} failed: ${err(e)}`));
      actions.append(b);
    }
    tr.append(actions);
    return tr;
  }

  function bondRow({ box, v }: BondRow, height: number): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const borrower = store.isMine(v.borrower),
      lender = store.isMine(v.lender);
    if (borrower || lender) tr.className = "mine";
    const left = v.maturity - height;
    tr.append(
      td(amountText(v.principalId, v.repayment)),
      td(`${v.maturity} (${left > 0 ? `${left} blocks left` : "matured"})`, "num"),
      td(collateralText(v)),
      tdCode(v.borrower, `${v.borrower.slice(0, 6)}…`, borrower ? " (you)" : ""),
      tdCode(v.lender, `${v.lender.slice(0, 6)}…`, lender ? " (you)" : ""),
    );
    const actions = document.createElement("td");
    const wallet = store.wallet;
    if (wallet && borrower && left > 0) {
      const b = document.createElement("button");
      b.textContent = "repay";
      b.onclick = () =>
        send(store, (hh, inputs) => buildRepay({ height: hh, inputs, borrower: wallet.changeAddress, bondBox: box }))
          .then(reload)
          .catch((e) => log(`repay failed: ${err(e)}`));
      actions.append(b);
    }
    if (wallet && left <= 0) {
      const b = document.createElement("button");
      b.textContent = lender ? "take collateral" : "hand collateral to the lender";
      b.onclick = () =>
        send(store, (hh, inputs) =>
          buildLiquidate({ height: hh, inputs, recipient: wallet.changeAddress, bondBox: box }),
        )
          .then(reload)
          .catch((e) => log(`liquidate failed: ${err(e)}`));
      actions.append(b);
    }
    tr.append(actions);
    return tr;
  }

  const ORDER_HEADS = ["Principal", "Repayment", "Term", "Collateral", "Borrower", ""];
  const BOND_HEADS = ["Repayment", "Matures", "Collateral", "Borrower", "Lender", ""];

  async function loadBonds() {
    try {
      const ex = store.explorer;
      const [o1, o2, b1, b2] = await Promise.all([
        ex.byTemplate(SIGMAFI_TEMPLATES.orderOnCloseErg),
        ex.byTemplate(SIGMAFI_TEMPLATES.orderOnCloseToken),
        ex.byTemplate(SIGMAFI_TEMPLATES.bondErg),
        ex.byTemplate(SIGMAFI_TEMPLATES.bondToken),
      ]);
      const height = await ex.height();
      const orders: OrderRow[] = [...o1, ...o2].flatMap((box) => {
        try {
          return [{ box, v: describeOrder(box) }];
        } catch {
          return [];
        }
      });
      const bonds: BondRow[] = [...b1, ...b2].flatMap((box) => {
        try {
          return [{ box, v: describeBond(box) }];
        } catch {
          return [];
        }
      });
      for (const { v } of [...orders, ...bonds])
        for (const t of [v.principalId, ...v.collateralTokens.map((c) => c.tokenId)])
          if (t !== ERG && !store.tokens.has(t)) await store.tokenInfo(t);
      orders.sort((a, b) => (b.v.principal > a.v.principal ? 1 : -1));
      bonds.sort((a, b) => a.v.maturity - b.v.maturity);

      // the visitor's own rows first, then the market without them
      const myOrders = orders.filter((r) => store.isMine(r.v.borrower));
      const myBonds = bonds.filter((r) => store.isMine(r.v.borrower) || store.isMine(r.v.lender));
      const mine: (HTMLElement | string)[] = [];
      if (!store.wallet) mine.push("connect a wallet to see your loan requests and bonds");
      else {
        if (myOrders.length) mine.push(h("h3", "Your loan requests"), table(ORDER_HEADS, myOrders.map(orderRow)));
        if (myBonds.length)
          mine.push(
            h("h3", "Your bonds (borrowed or lent)"),
            table(
              BOND_HEADS,
              myBonds.map((r) => bondRow(r, height)),
            ),
          );
        if (!mine.length) mine.push("none");
      }
      $("bonds-mine").replaceChildren(...mine);
      // the market, collapsed as the Limit orders tab's groups are, the count on the summary line
      const others = orders.filter((r) => !myOrders.includes(r));
      $("orders-count").textContent = `${others.length} open`;
      $("orders-list").replaceChildren(
        others.length ? table(ORDER_HEADS, others.map(orderRow)) : "no open loan requests",
      );
      const otherBonds = bonds.filter((r) => !myBonds.includes(r));
      $("bonds-count").textContent = `${otherBonds.length} live`;
      $("bonds-list").replaceChildren(
        otherBonds.length
          ? table(
              BOND_HEADS,
              otherBonds.map((r) => bondRow(r, height)),
            )
          : "no bonds",
      );

      const sel = $<HTMLSelectElement>("loan-token");
      if (sel.options.length <= 1)
        for (const t of tokenlist.tokens) sel.append(option(t.name || t.id.slice(0, 8), t.id));
    } catch (e) {
      $("orders-list").textContent = `could not load: ${err(e)}`;
    }
  }

  $<HTMLFormElement>("open-order").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const principalId = $<HTMLSelectElement>("loan-token").value;
      const dec = store.decimalsOf(principalId);
      const principal = parseUnits($<HTMLInputElement>("loan-amount").value, dec);
      const repayment = parseUnits($<HTMLInputElement>("loan-repay").value, dec);
      const term = Number($<HTMLInputElement>("loan-term").value);
      const collErgText = $<HTMLInputElement>("loan-coll-erg").value.trim();
      const collTok = $<HTMLInputElement>("loan-coll-token").value.trim().toLowerCase();
      const collAmtText = $<HTMLInputElement>("loan-coll-amount").value.trim();
      const collateralErg = collErgText ? parseUnits(collErgText, ERG_DECIMALS) : 0n;
      const collateralTokens = collTok
        ? [{ tokenId: collTok, amount: parseUnits(collAmtText, (await store.tokenInfo(collTok)).decimals) }]
        : [];
      if (collateralErg <= 0n && collateralTokens.length === 0) throw new Error("name some collateral");
      const borrower = store.wallet!.changeAddress;
      await send(store, (height, inputs) =>
        buildOpenOrder({
          height,
          inputs,
          borrower,
          principalId,
          principal,
          repayment,
          term,
          collateralErg,
          collateralTokens,
        }),
      );
      reload();
    } catch (e) {
      log(`loan request failed: ${err(e)}`);
    }
  };

  return { show: () => void loadBonds() };
}
