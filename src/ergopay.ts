// Signing from a phone with ErgoPay (EIP-20) in its static mode: the reduced transaction travels inside the QR code
// or the `ergopay:` link itself, so there is no server. The page reduces the unsigned transaction with sigma-rust's
// WASM binding against the last ten block headers from the explorer, shows the code, and watches the explorer for
// the transaction id, which is the same before and after signing; the wallet signs and submits. The mobile wallet
// (and Terminus, its iOS build) has no dApp connector, so this is its only path. No DOM here: the page passes hooks.
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, Network } from "@fleet-sdk/core";
import type * as ErgoLib from "ergo-lib-wasm-browser";
import type { Explorer } from "./explorer";
import type { Signer } from "./wallet";

/** The binding's module shape; the Node build (`ergo-lib-wasm-nodejs`) has the same API, so scripts pass that. */
export type ErgoLibModule = typeof ErgoLib;

/** EIP-20: links and QR codes handle up to about 2,900 characters. The page stops short of that. */
export const QR_MAX_CHARS = 2800;
/** `ErgoStateContext` wants the last ten headers, newest first, which is the explorer's order. */
export const HEADERS_NEEDED = 10;
export const POLL_MS = 10_000;
export const POLL_TIMEOUT_MS = 20 * 60 * 1000;
/** Inputs a phone-signed transaction spent are left out of the next build for this long (the explorer may still list them). */
export const SPENT_MEMORY_MS = 15 * 60 * 1000;
export const PHONE_STORAGE_KEY = "freedex.phone";

/** Base64 with the URL-safe alphabet, padded, the way the reference wallet's Java encoder writes it. */
export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

export function ergopayLink(reduced: Uint8Array): string {
  return `ergopay:${base64url(reduced)}`;
}

/** Why a link cannot go in a QR code, or undefined when it fits. */
export function sizeGuard(link: string): string | undefined {
  if (link.length <= QR_MAX_CHARS) return undefined;
  return (
    `the reduced transaction is ${link.length} characters, above the ${QR_MAX_CHARS} a QR code can carry; ` +
    `build it from fewer inputs (consolidate your boxes with one send-to-self from the wallet first)`
  );
}

/** A mainnet P2PK address typed by the visitor, or the reason it is refused. */
export function parsePhoneAddress(text: string): { address?: ErgoAddress; why?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { why: "no address given" };
  let address: ErgoAddress;
  try {
    address = ErgoAddress.fromBase58(trimmed);
  } catch {
    return { why: "not an Ergo address" };
  }
  if (address.network !== Network.Mainnet) return { why: "not a mainnet address (mainnet addresses start with 9)" };
  return { address };
}

export interface Reduced {
  bytes: Uint8Array;
  txId: string;
  link: string;
}

/**
 * The unsigned transaction with each input's script reduced to a sigma proposition, which is what a wallet signs
 * without the boxes. Needs the inputs and data inputs in full (the EIP-12 object carries them) and a state context
 * from the last ten headers; the pre-header is the newest, as Nautilus builds it.
 */
export function reduceTransaction(lib: ErgoLibModule, tx: EIP12UnsignedTransaction, headers: unknown[]): Reduced {
  if (headers.length < HEADERS_NEEDED)
    throw new Error(`need the last ${HEADERS_NEEDED} block headers, the explorer gave ${headers.length}`);
  const hs = lib.BlockHeaders.from_json(headers.slice(0, HEADERS_NEEDED));
  const pre = lib.PreHeader.from_block_header(hs.get(0));
  const ctx = new lib.ErgoStateContext(pre, hs, lib.Parameters.default_parameters());
  const inputs = lib.ErgoBoxes.from_boxes_json(tx.inputs);
  const dataInputs = lib.ErgoBoxes.from_boxes_json(tx.dataInputs);
  const unsigned = lib.UnsignedTransaction.from_json(JSON.stringify(tx));
  const txId = unsigned.id().to_str();
  const reduced = lib.ReducedTransaction.from_unsigned_tx(unsigned, inputs, dataInputs, ctx);
  const bytes = reduced.sigma_serialize_bytes();
  return { bytes, txId, link: ergopayLink(bytes) };
}

/** An explorer box in the EIP-12 shape the builders take as inputs. */
export function toEip12Box(b: Box<bigint>): Box<string> {
  return {
    ...b,
    value: b.value.toString(),
    assets: b.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
  };
}

export interface PhoneHooks {
  /** The code and link are ready; `cancel` stops the wait with an error. */
  show(r: Reduced, cancel: () => void): void;
  /** A line while the page waits (minutes left). */
  status(text: string): void;
  /** The transaction was seen, the wait timed out, or the visitor cancelled. */
  hide(): void;
}

export interface PhoneOptions {
  /** The WASM binding, loaded only when the phone path is chosen. */
  loadLib: () => Promise<ErgoLibModule>;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The phone as the signer: boxes and balances from the explorer by address, the height from the explorer, and
 * `sign` as reduce, show, wait. Resolves with the id once the explorer sees the transaction in the mempool or a block.
 */
export function phoneSigner(address: ErgoAddress, explorer: Explorer, hooks: PhoneHooks, opts: PhoneOptions): Signer {
  const encoded = address.encode();
  const pollMs = opts.pollMs ?? POLL_MS;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  /** box id -> when a phone-signed transaction spent it */
  const spent = new Map<string, number>();

  async function utxos(): Promise<Box<string>[]> {
    const boxes = await explorer.unspentByAddress(encoded);
    for (const [id, at] of spent) if (now() - at > SPENT_MEMORY_MS) spent.delete(id);
    return boxes.filter((b) => !spent.has(b.boxId)).map(toEip12Box);
  }

  async function sign(tx: EIP12UnsignedTransaction): Promise<string> {
    const lib = await opts.loadLib();
    const headers = await explorer.headers(HEADERS_NEEDED);
    const r = reduceTransaction(lib, tx, headers);
    const tooBig = sizeGuard(r.link);
    if (tooBig) throw new Error(tooBig);
    let cancelled = false;
    hooks.show(r, () => (cancelled = true));
    try {
      const deadline = now() + timeoutMs;
      for (;;) {
        if (await explorer.seen(r.txId, encoded)) {
          for (const i of tx.inputs) spent.set(i.boxId, now());
          return r.txId;
        }
        if (cancelled) throw new Error("cancelled; nothing was submitted unless the phone already did");
        const left = deadline - now();
        if (left <= 0)
          throw new Error(
            `no transaction ${r.txId.slice(0, 8)}… seen in ${Math.round(timeoutMs / 60_000)} minutes; build it again to retry`,
          );
        hooks.status(`waiting for the wallet, ${Math.ceil(left / 60_000)} min left`);
        await sleep(pollMs);
      }
    } finally {
      hooks.hide();
    }
  }

  return {
    kind: "ergopay",
    name: "phone",
    changeAddress: address,
    usedAddresses: [encoded],
    height: () => explorer.height(),
    utxos,
    balance: async (tokenId: string) => {
      const boxes = await utxos();
      let sum = 0n;
      for (const b of boxes) {
        if (tokenId === "ERG") sum += BigInt(b.value);
        else for (const a of b.assets) if (a.tokenId === tokenId) sum += BigInt(a.amount);
      }
      return sum;
    },
    sign,
    disconnect: async () => {},
  };
}
