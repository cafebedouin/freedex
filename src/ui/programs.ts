// The Programs tab: clocked boxes (contracts/Clock.es). Create a program (an ERG budget bought in slices, one per
// interval, from the token's deepest ERG pool; anyone may run a leg for the fee the owner sets), list the
// visitor's own programs with their next due height and legs left, cancel one; and every open program on the
// contract, read-only, which is what the upkeep runner sees.
import type { Box } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import {
  BLOCKS_PER_DAY,
  CLOCK_TEMPLATE_SHA256,
  OWNER_BOX_VALUE,
  RENT_PERIOD,
  buildCancelClock,
  buildCreateClock,
  describeClock,
  describeInterval,
  sizeProgram,
  type ClockView,
} from "../clock";
import { FEE } from "../orders";
import { ERG_DECIMALS, formatUnits, parseUnits } from "../units";
import { $, dl, err, log, option, table, td, tdCode } from "./dom";
import { OTHER, type Store } from "./store";
import { send } from "./wallet";

type Row = { box: Box<bigint>; v: ClockView };
const GENERATOR = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export function mountPrograms(store: Store) {
  const reload = () => setTimeout(() => void loadPrograms(), 3000);
  let height = 0;

  function fillTokens() {
    const sel = $<HTMLSelectElement>("prog-token-pick");
    sel.replaceChildren();
    for (const p of store.state.pools) {
      const id = p.box.assets[2].tokenId;
      if (!store.whitelisted(id) || [...sel.options].some((o) => o.value === id)) continue;
      sel.append(option(store.nameOf(id), id));
    }
    sel.append(option("other (type the id below)", OTHER));
    sel.onchange = () => {
      $<HTMLInputElement>("prog-token").value = sel.value === OTHER ? "" : sel.value;
      quoteProgram();
    };
    $<HTMLInputElement>("prog-token").value = sel.value === OTHER ? "" : sel.value;
  }

  /** What the form would create, or the reason it cannot. */
  function readForm() {
    const tokenId = $<HTMLInputElement>("prog-token").value.trim().toLowerCase();
    const pool = store.deepestPool(tokenId);
    if (!pool) throw new Error("no ErgoDEX ERG pool for that token");
    const amount = parseUnits($<HTMLInputElement>("prog-amount").value || "0", ERG_DECIMALS);
    const slice = parseUnits($<HTMLInputElement>("prog-slice").value || "0", ERG_DECIMALS);
    if (slice <= 0n) throw new Error("slice must be positive");
    if (amount < slice || amount % slice !== 0n) throw new Error("the amount must be a whole number of slices");
    const interval = Number($<HTMLInputElement>("prog-interval").value);
    const tolText = $<HTMLInputElement>("prog-tolerance").value.trim();
    const toleranceBps = tolText ? parseUnits(tolText, 2) : 0n;
    const decimals = store.decimalsOf(tokenId);
    const capText = $<HTMLInputElement>("prog-cap").value.trim();
    // ERG per whole token to nanoERG per smallest unit: an integer, or the cap cannot be expressed
    let maxPrice = 0n;
    if (capText) {
      const perWhole = parseUnits(capText, ERG_DECIMALS);
      const unit = 10n ** BigInt(decimals);
      if (perWhole % unit !== 0n)
        throw new Error(
          `the cap must be a whole number of nanoERG per smallest unit (a multiple of ${formatUnits(unit, ERG_DECIMALS)} ERG per token)`,
        );
      maxPrice = perWhole / unit;
    }
    const executorFee = parseUnits($<HTMLInputElement>("prog-fee").value || "0", ERG_DECIMALS);
    return {
      // without a wallet the quote still needs a 33-byte key to size the box: the curve's generator, never an output
      owner: store.wallet?.changeAddress ?? ErgoAddress.fromPublicKey(GENERATOR),
      tokenId,
      poolBox: pool.box,
      slice,
      interval,
      toleranceBps,
      executorFee,
      maxPrice,
      legs: Number(amount / slice),
    };
  }

  function quoteProgram() {
    const q = $<HTMLDListElement>("prog-quote");
    const go = $<HTMLButtonElement>("prog-go");
    try {
      const p = readForm();
      const s = sizeProgram(p);
      dl(q, [
        ["legs", `${p.legs}, one every ${describeInterval(p.interval)}`],
        ["schedule", `${describeInterval(p.legs * p.interval)} if every leg runs on time`],
        [
          "per leg",
          `${formatUnits(p.slice, ERG_DECIMALS)} ERG into the pool, ${formatUnits(p.executorFee, ERG_DECIMALS)} ERG to whoever runs it`,
        ],
        [
          "executor keeps",
          `${formatUnits(p.executorFee - FEE - OWNER_BOX_VALUE, ERG_DECIMALS)} ERG after the miner fee and your token box`,
        ],
        [
          "rent reserve",
          `${formatUnits(s.rentReserve, ERG_DECIMALS)} ERG held in the box, back to you with the last leg (${s.bytes} bytes)`,
        ],
        ["locked now", `${formatUnits(s.value, ERG_DECIMALS)} ERG plus the miner fee`],
      ]);
      go.disabled = !store.wallet;
    } catch (e) {
      dl(q, [["", err(e)]]);
      go.disabled = true;
    }
  }

  function row({ box, v }: Row): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const mine = store.isMine(v.owner);
    if (mine) tr.className = "mine";
    const due = height >= v.dueAt ? "due now" : `in ${v.dueAt - height} blocks`;
    tr.append(
      td(store.nameOf(v.tokenId)),
      td(`${formatUnits(v.slice, ERG_DECIMALS)} ERG`, "num"),
      td(describeInterval(Number(v.interval))),
      td(`${v.dueAt} (${due})`),
      td(String(v.legsLeft), "num"),
      td(`${formatUnits(v.value, ERG_DECIMALS)} ERG`, "num"),
      tdCode(v.owner, `${v.owner.slice(0, 6)}…`, mine ? " (you)" : ""),
    );
    const actions = document.createElement("td");
    const wallet = store.wallet;
    if (wallet && mine) {
      const b = document.createElement("button");
      b.textContent = "cancel";
      b.onclick = () =>
        send(store, (h) => buildCancelClock({ height: h, owner: wallet.changeAddress, clockBox: box }))
          .then(reload)
          .catch((e) => log(`cancel failed: ${err(e)}`));
      actions.append(b);
    }
    tr.append(actions);
    return tr;
  }

  const HEADS = ["Token", "Slice", "Interval", "Next due", "Legs left", "In the box", "Owner", ""];

  async function loadPrograms() {
    try {
      const [boxes, h] = await Promise.all([
        store.explorer.byTemplate(CLOCK_TEMPLATE_SHA256, 500),
        store.explorer.height(),
      ]);
      height = h;
      const all: Row[] = boxes.flatMap((box) => {
        try {
          return [{ box, v: describeClock(box) }];
        } catch {
          return [];
        }
      });
      for (const { v } of all) if (!store.tokens.has(v.tokenId)) await store.tokenInfo(v.tokenId);
      const mine = all.filter(({ v }) => store.isMine(v.owner));
      const others = all.filter((r) => !mine.includes(r));
      $("programs-mine").replaceChildren(
        !store.wallet ? "connect a wallet to see your programs" : mine.length ? table(HEADS, mine.map(row)) : "none",
      );
      $("programs-list").replaceChildren(
        others.length ? table(HEADS, others.map(row)) : "no other open programs on the contract",
      );
    } catch (e) {
      $("programs-list").textContent = `could not load: ${err(e)}`;
    }
  }

  for (const id of [
    "prog-token",
    "prog-amount",
    "prog-slice",
    "prog-interval",
    "prog-tolerance",
    "prog-cap",
    "prog-fee",
  ])
    $<HTMLInputElement>(id).oninput = () => {
      if (id === "prog-interval") {
        const n = Number($<HTMLInputElement>("prog-interval").value);
        $("prog-interval-days").textContent =
          Number.isInteger(n) && n > 0 ? describeInterval(n).replace(/^\d+ blocks /, "") : "";
      }
      quoteProgram();
    };

  $<HTMLFormElement>("create-program").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const p = readForm();
      if (p.legs * p.interval > RENT_PERIOD)
        throw new Error(`the schedule must end within ${RENT_PERIOD} blocks (${RENT_PERIOD / BLOCKS_PER_DAY} days)`);
      const fresh = await store.explorer.poolByNft(p.poolBox.assets[0].tokenId);
      await send(store, (height, inputs) => buildCreateClock({ ...p, poolBox: fresh.box, height, inputs }));
      reload();
    } catch (e) {
      log(`program failed: ${err(e)}`);
    }
  };

  store.subscribe("pools", () => {
    fillTokens();
    quoteProgram();
  });
  store.subscribe("wallet", () => {
    quoteProgram();
    void loadPrograms();
  });

  return {
    show: () => {
      quoteProgram();
      void loadPrograms();
    },
  };
}
