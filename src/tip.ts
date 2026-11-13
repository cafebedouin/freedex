// Tip consistency: the page reads contract boxes (pools, the bank, orders, provisions, vaults) from the explorer, but
// the transaction is checked and submitted by another node (the browser wallet's, or the phone wallet's). The two can
// disagree by a block or more. Right before a transaction goes to the signer, every box the page brought itself is
// read again by id: one the explorer has seen spent, or no longer knows, is refused; one confirmed in a block the
// signer's side may not have yet is refused with the wait stated. And a signer's refusal is said in plain words.
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import type { BoxState, Explorer } from "./explorer";
import type { SignerKind } from "./wallet";

/**
 * How deep a box the page brought must be before it builds on it, counted against the signer's height. The browser
 * wallet reports its own node's height, so one confirmation there means its node has the block. On the phone path the
 * only height is the explorer's, the same source as the box, so the page asks for one block more as a margin for a
 * phone wallet's node one block behind.
 */
export const MIN_CONFIRMATIONS: Record<SignerKind, number> = { eip12: 1, ergopay: 2 };
/** Ergo's target block interval, for the wait the page states. */
export const BLOCK_MINUTES = 2;

export type TipCode = "spent" | "not-visible" | "too-fresh";

/** Why a transaction was not handed to the signer: `code` says which rule, the message what to do. */
export class TipRefusal extends Error {
  readonly code: TipCode;
  readonly boxId: string;
  constructor(code: TipCode, boxId: string, message: string) {
    super(message);
    this.name = "TipRefusal";
    this.code = code;
    this.boxId = boxId;
  }
}

const short = (id: string) => `${id.slice(0, 8)}…`;
const AGAIN = "press the button again to rebuild against the newest boxes";

/** The check for one box, given what the explorer says of it now. Throws a `TipRefusal`, or returns. */
export function judgeBox(
  boxId: string,
  s: BoxState,
  signer: { kind: SignerKind; height: number },
  minConfirmations = MIN_CONFIRMATIONS[signer.kind],
): void {
  if (s.state === "mempool") return; // built on a pending transaction on purpose (latestByToken)
  if (s.state === "unknown")
    throw new TipRefusal(
      "not-visible",
      boxId,
      `box ${short(boxId)} is no longer known to the explorer (spent in the mempool and gone from its listing, or its block was rolled back); nothing was signed; ${AGAIN}`,
    );
  if (s.spentBy)
    throw new TipRefusal(
      "spent",
      boxId,
      `box ${short(boxId)} was spent by transaction ${short(s.spentBy)} after the page read it; nothing was signed; ${AGAIN}`,
    );
  const enough = s.height + minConfirmations - 1;
  if (enough > signer.height) {
    const blocks = enough - signer.height;
    const who =
      signer.kind === "eip12"
        ? `your wallet reports block ${signer.height}, so its node may not have that block yet`
        : `the explorer is at block ${signer.height}, and the phone path waits for ${minConfirmations} confirmations so the phone's node has it too`;
    throw new TipRefusal(
      "too-fresh",
      boxId,
      `box ${short(boxId)} was confirmed in block ${s.height}; ${who}. Nothing was signed: wait ${blocks} block${blocks === 1 ? "" : "s"} (about ${blocks * BLOCK_MINUTES} minutes) and press the button again`,
    );
  }
}

/**
 * Re-reads every input and data input the signer did not supply (the boxes the page brought from the explorer) and
 * judges each (`judgeBox`). Returns the newest inclusion height among them (0 when none is confirmed), which the
 * phone path holds its headers against. A failed read stops the transaction: the page does not hand over what it
 * could not check.
 */
export async function checkInputs(
  explorer: Pick<Explorer, "boxState">,
  tx: EIP12UnsignedTransaction,
  own: Set<string>,
  signer: { kind: SignerKind; height: number },
): Promise<number> {
  const ids = [...new Set([...tx.inputs, ...tx.dataInputs].map((b) => b.boxId))].filter((id) => !own.has(id));
  const states = await Promise.all(ids.map((id) => explorer.boxState(id)));
  let newest = 0;
  ids.forEach((id, k) => {
    const s = states[k];
    judgeBox(id, s, signer);
    if (s.state === "confirmed" && s.height > newest) newest = s.height;
  });
  return newest;
}

/** The text of whatever a wallet threw: an Error, an EIP-12 `{code, info}` object, or anything else. */
export function failureText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { info?: unknown; message?: unknown; code?: unknown };
    if (typeof o.info === "string" && o.info) return o.info;
    if (typeof o.message === "string" && o.message) return o.message;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

/** What the page says instead of a wallet's or node's raw refusal, for the refusals it knows. */
export const FAILURE_NOTES = {
  versions:
    "your wallet could not read a contract this transaction spends: its signing library does not parse ErgoTree version 2 or 3 (Nautilus 1.4 fails this way, with NonConsumedBytes, until it ships sigma-rust 0.29). Nothing was signed. See the experimental note at the top of the tab",
  doubleSpend:
    "the node refused it as a double spend: a box it spends (a pool, the vault or another shared box) was spent by someone else's transaction first. Nothing of yours moved; press the button again to rebuild against the newest boxes",
  missingInput:
    "the wallet's node does not have one of the boxes it spends: the box was spent already, or that node is behind the explorer this page reads. Nothing of yours moved; wait a block (about 2 minutes) and press the button again",
} as const;

/** A signer's failure in plain words when it is one the page recognises; otherwise its own text. */
export function explainFailure(e: unknown): string {
  const text = failureText(e);
  if (/NonConsumedBytes/i.test(text)) return `${FAILURE_NOTES.versions} (wallet: ${text.slice(0, 120)})`;
  if (/double.?spen/i.test(text)) return `${FAILURE_NOTES.doubleSpend} (node: ${text.slice(0, 160)})`;
  if (
    /should be in UTXO|missing inputs?|input .*not found|box with id \S+ not found|inputs? (are |is )?not (found|in utxo)/i.test(
      text,
    )
  )
    return `${FAILURE_NOTES.missingInput} (node: ${text.slice(0, 160)})`;
  return text;
}
