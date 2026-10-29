// The Programs tab: clocked boxes of both sides (contracts/Clock.es buys, contracts/ClockSell.es sells). Create a
// program (buy: an ERG budget bought in slices, one per interval, from the token's deepest ERG pool; sell: a token
// amount sold in slices into it; anyone may run a leg for the fee the owner sets), list the visitor's own programs
// with their next due height and legs left, cancel one; and every open program on either contract, read-only,
// which is what the upkeep runner sees.
import type { Box } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import {
  BLOCKS_PER_DAY,
  CLOCK_SELL_TEMPLATE_SHA256,
  CLOCK_TEMPLATE_SHA256,
  OWNER_BOX_VALUE,
  RENT_PERIOD,
  buildCancelClock,
  buildCreateClock,
  buildCreateClockSell,
  describeClock,
  describeInterval,
  sizeProgram,
  sizeProgramSell,
  type ClockProgram,
  type ClockSellProgram,
  type ClockSide,
  type ClockView,
} from "../clock";
import { FEE } from "../orders";
import { ERG_DECIMALS, formatUnits, parseUnits } from "../units";
import { $, dl, err, log, option, table, td, tdCode } from "./dom";
import { OTHER, type Store } from "./store";
import { send } from "./wallet";

type Row = { box: Box<bigint>; v: ClockView };
type Form = { side: "buy"; program: ClockProgram } | { side: "sell"; program: ClockSellProgram };
const GENERATOR = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export function mountPrograms(store: Store) {
  const reload = () => setTimeout(() => void loadPrograms(), 3000);
  let height = 0;
  const side = () => $<HTMLSelectElement>("prog-side").value as ClockSide;

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

  /** The field labels follow the side: ERG amounts and a cap for a buy, token amounts and a floor for a sale. */
  function relabel() {
    const buy = side() === "buy";
    $("prog-amount-label").textContent = buy ? "ERG to spend in all" : "Tokens to sell in all";
    $("prog-slice-label").textContent = buy ? "ERG per leg (slice)" : "Tokens per leg (slice)";
    $("prog-cap-label").textContent = buy
      ? "Price cap (ERG per token, blank for none)"
      : "Price floor (ERG per token, blank for none)";
  }

  /** ERG per whole token to nanoERG per smallest unit: an integer, or the bound cannot be expressed. */
  function unitPrice(text: string, decimals: number, what: string): bigint {
    if (!text) return 0n;
    const perWhole = parseUnits(text, ERG_DECIMALS);
    const unit = 10n ** BigInt(decimals);
    if (perWhole % unit !== 0n)
      throw new Error(
        `the ${what} must be a whole number of nanoERG per smallest unit (a multiple of ${formatUnits(unit, ERG_DECIMALS)} ERG per token)`,
      );
    return perWhole / unit;
  }

  /** What the form would create, or the reason it cannot. */
  function readForm(): Form {
    const tokenId = $<HTMLInputElement>("prog-token").value.trim().toLowerCase();
    const pool = store.deepestPool(tokenId);
    if (!pool) throw new Error("no ErgoDEX ERG pool for that token");
    const interval = Number($<HTMLInputElement>("prog-interval").value);
    const tolText = $<HTMLInputElement>("prog-tolerance").value.trim();
    const toleranceBps = tolText ? parseUnits(tolText, 2) : 0n;
    const decimals = store.decimalsOf(tokenId);
    const bound = $<HTMLInputElement>("prog-cap").value.trim();
    const executorFee = parseUnits($<HTMLInputElement>("prog-fee").value || "0", ERG_DECIMALS);
    const common = {
      // without a wallet the quote still needs a 33-byte key to size the box: the curve's generator, never an output
      owner: store.wallet?.changeAddress ?? ErgoAddress.fromPublicKey(GENERATOR),
      tokenId,
      poolBox: pool.box,
      interval,
      toleranceBps,
      executorFee,
    };
    if (side() === "buy") {
      const amount = parseUnits($<HTMLInputElement>("prog-amount").value || "0", ERG_DECIMALS);
      const slice = parseUnits($<HTMLInputElement>("prog-slice").value || "0", ERG_DECIMALS);
      if (slice <= 0n) throw new Error("slice must be positive");
      if (amount < slice || amount % slice !== 0n) throw new Error("the amount must be a whole number of slices");
      const maxPrice = unitPrice(bound, decimals, "cap");
      return { side: "buy", program: { ...common, slice, maxPrice, legs: Number(amount / slice) } };
    }
    const tokens = parseUnits($<HTMLInputElement>("prog-amount").value || "0", decimals);
    const slice = parseUnits($<HTMLInputElement>("prog-slice").value || "0", decimals);
    const minPrice = unitPrice(bound, decimals, "floor");
    return { side: "sell", program: { ...common, tokens, slice, minPrice } };
  }

  function quoteProgram() {
    const q = $<HTMLDListElement>("prog-quote");
    const go = $<HTMLButtonElement>("prog-go");
    try {
      const f = readForm();
      const fee = formatUnits(f.program.executorFee, ERG_DECIMALS);
      if (f.side === "buy") {
        const p = f.program;
        const s = sizeProgram(p);
        dl(q, [
          ["legs", `${p.legs}, one every ${describeInterval(p.interval)}`],
          ["schedule", `${describeInterval(p.legs * p.interval)} if every leg runs on time`],
          ["per leg", `${formatUnits(p.slice, ERG_DECIMALS)} ERG into the pool, ${fee} ERG to whoever runs it`],
          [
            "executor keeps",
            `${formatUnits(p.executorFee - FEE - OWNER_BOX_VALUE, ERG_DECIMALS)} ERG after the miner fee and your token box`,
          ],
          [
            "rent",
            `none held: the box is ERG, so a storage-rent claim on a box left ${RENT_PERIOD / BLOCKS_PER_DAY} days would take its fee (${formatUnits(s.rentFeeWouldBe, ERG_DECIMALS)} ERG for ${s.bytes} bytes) from the budget and leave a smaller program; a program that runs on schedule never pays it`,
          ],
          ["locked now", `${formatUnits(s.value, ERG_DECIMALS)} ERG plus the miner fee`],
        ]);
      } else {
        const p = f.program;
        const s = sizeProgramSell(p);
        const dec = store.decimalsOf(p.tokenId);
        const name = store.nameOf(p.tokenId);
        const rest = p.tokens - BigInt(s.legs) * p.slice;
        dl(q, [
          [
            "legs",
            `${s.legs}, one every ${describeInterval(p.interval)}${rest > 0n ? `; the last sells ${formatUnits(p.slice + rest, dec)} ${name}` : ""}`,
          ],
          ["schedule", `${describeInterval(s.legs * p.interval)} if every leg runs on time`],
          ["per leg", `${formatUnits(p.slice, dec)} ${name} into the pool, ${fee} ERG to whoever runs it`],
          [
            "executor keeps",
            `${formatUnits(p.executorFee - FEE, ERG_DECIMALS)} ERG after the miner fee (less a top-up of your ERG box to ${formatUnits(OWNER_BOX_VALUE, ERG_DECIMALS)} ERG when a leg's proceeds fall below it)`,
          ],
          [
            "rent reserve",
            `${formatUnits(s.rentReserve, ERG_DECIMALS)} ERG held in the box, back to you with the last leg: one rent fee for ${s.bytes} bytes, because a token box that cannot pay rent is consumed whole, tokens included`,
          ],
          [
            "locked now",
            `${formatUnits(p.tokens, dec)} ${name} and ${formatUnits(s.value, ERG_DECIMALS)} ERG (the fees, the reserve and the box minimum) plus the miner fee`,
          ],
        ]);
      }
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
    const name = store.nameOf(v.tokenId);
    const dec = store.decimalsOf(v.tokenId);
    const erg = `${formatUnits(v.value, ERG_DECIMALS)} ERG`;
    tr.append(
      td(name),
      td(v.side),
      td(
        v.side === "buy" ? `${formatUnits(v.slice, ERG_DECIMALS)} ERG` : `${formatUnits(v.slice, dec)} ${name}`,
        "num",
      ),
      td(describeInterval(Number(v.interval))),
      td(`${v.dueAt} (${due})`),
      td(String(v.legsLeft), "num"),
      td(v.side === "buy" ? erg : `${formatUnits(v.tokens, dec)} ${name}, ${erg}`, "num"),
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

  const HEADS = ["Token", "Side", "Slice", "Interval", "Next due", "Legs left", "In the box", "Owner", ""];

  async function loadPrograms() {
    try {
      const [buys, sells, h] = await Promise.all([
        store.explorer.byTemplate(CLOCK_TEMPLATE_SHA256, 500),
        store.explorer.byTemplate(CLOCK_SELL_TEMPLATE_SHA256, 500),
        store.explorer.height(),
      ]);
      height = h;
      const all: Row[] = [...buys, ...sells].flatMap((box) => {
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
        others.length ? table(HEADS, others.map(row)) : "no other open programs on either contract",
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
  $<HTMLSelectElement>("prog-side").onchange = () => {
    relabel();
    quoteProgram();
  };

  $<HTMLFormElement>("create-program").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const f = readForm();
      const legs = f.side === "buy" ? f.program.legs : sizeProgramSell(f.program).legs;
      if (legs * f.program.interval > RENT_PERIOD)
        throw new Error(`the schedule must end within ${RENT_PERIOD} blocks (${RENT_PERIOD / BLOCKS_PER_DAY} days)`);
      const fresh = await store.explorer.poolByNft(f.program.poolBox.assets[0].tokenId);
      await send(store, (height, inputs) =>
        f.side === "buy"
          ? buildCreateClock({ ...f.program, poolBox: fresh.box, height, inputs })
          : buildCreateClockSell({ ...f.program, poolBox: fresh.box, height, inputs }),
      );
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

  relabel();
  return {
    show: () => {
      quoteProgram();
      void loadPrograms();
    },
  };
}
