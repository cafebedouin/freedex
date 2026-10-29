// The header's signer control (connect a browser wallet, or sign with your phone) and `send`, the one path every
// tab's transaction takes: build from the signer's boxes at its height, then sign and submit through it. For the
// phone that means a reduced transaction shown as a QR code and an `ergopay:` link, then a wait on the explorer.
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import type { ErgoAddress } from "@fleet-sdk/core";
import { PHONE_STORAGE_KEY, POLL_MS, POLL_TIMEOUT_MS, parsePhoneAddress, phoneSigner } from "../ergopay";
import type { PhoneHooks } from "../ergopay";
import { availableWallets, connect } from "../wallet";
import { $, err, log } from "./dom";
import { drawQr } from "./qr";
import type { Store } from "./store";

export type Builder = (height: number, inputs: Box<string>[]) => EIP12UnsignedTransaction;

export async function send(store: Store, build: Builder): Promise<string> {
  const wallet = store.wallet;
  if (!wallet) throw new Error("connect a wallet first");
  const height = await wallet.height();
  const inputs = await wallet.utxos();
  const tx = build(height, inputs);
  log(
    `built: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs, height ${height}; waiting for the ${wallet.kind === "ergopay" ? "phone" : "wallet"}`,
  );
  const txId = await wallet.sign(tx);
  log(`submitted ${txId}\n${store.explorer.txUrl(txId)}`);
  store.explorer.invalidate();
  return txId;
}

/** The 2.7 MB WASM binding, fetched only when the phone path is chosen. */
const loadLib = () => import("ergo-lib-wasm-browser");

function storedPhone(): string | undefined {
  try {
    return localStorage.getItem(PHONE_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storePhone(address: string) {
  try {
    localStorage.setItem(PHONE_STORAGE_KEY, address);
  } catch {
    /* private mode: the address is asked again next time */
  }
}

const short = (addr: string) => `${addr.slice(0, 8)}…${addr.slice(-6)}`;

/** The "Sign on your phone" panel: the code, the link, the id, the wait. */
function phonePanel(): PhoneHooks {
  const panel = $("ergopay");
  const canvas = $<HTMLCanvasElement>("ergopay-qr");
  const link = $<HTMLAnchorElement>("ergopay-link");
  const txid = $("ergopay-txid");
  const status = $("ergopay-status");
  const cancel = $<HTMLButtonElement>("ergopay-cancel");
  return {
    show(r, stop) {
      link.href = r.link;
      txid.textContent = r.txId;
      status.textContent = "";
      canvas.hidden = !drawQr(canvas, r.link);
      cancel.onclick = stop;
      panel.hidden = false;
      panel.scrollIntoView?.({ block: "nearest" });
      log(
        `reduced to ${r.bytes.length} bytes, a ${r.link.length}-character link; scan the code with the wallet, or open the link on this device; waiting for ${r.txId}`,
      );
    },
    status(text) {
      status.textContent = text;
    },
    hide() {
      panel.hidden = true;
      cancel.onclick = null;
    },
  };
}

export function mountWallet(store: Store) {
  const el = $<HTMLSpanElement>("wallet");
  const hooks = phonePanel();

  function usePhone(address: ErgoAddress) {
    const signer = phoneSigner(address, store.explorer, hooks, {
      loadLib,
      pollMs: POLL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    log(`signing with your phone as ${address.encode()}; your boxes and balances are read from the explorer`);
    store.setWallet(signer);
  }

  function askPhone() {
    const typed = window.prompt(
      "Your Ergo address (mainnet, from the Ergo mobile wallet or Terminus). The page reads your boxes from the explorer and shows each transaction as a QR code for the wallet to sign; the address stays in this browser.",
      storedPhone() ?? "",
    );
    if (typed === null) return;
    const { address, why } = parsePhoneAddress(typed);
    if (!address) {
      log(`phone: ${why}`);
      return;
    }
    storePhone(address.encode());
    usePhone(address);
  }

  function button(label: string, onclick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = onclick;
    return b;
  }

  function render() {
    el.replaceChildren();
    const wallet = store.wallet;
    if (wallet) {
      el.append(
        `${wallet.name}: ${short(wallet.changeAddress.encode())} `,
        button("disconnect", async () => {
          await wallet.disconnect();
          store.setWallet(undefined);
        }),
      );
      return;
    }
    for (const name of availableWallets()) {
      el.append(
        button(`connect ${name}`, async () => {
          try {
            const w = await connect(name);
            log(`connected ${name}, change address ${w.changeAddress.encode()}`);
            store.setWallet(w);
          } catch (e) {
            log(`connect failed: ${err(e)}`);
            store.setWallet(undefined);
          }
        }),
        " ",
      );
    }
    const stored = storedPhone();
    const known = stored ? parsePhoneAddress(stored).address : undefined;
    el.append(
      button(known ? `sign with your phone (${short(stored!)})` : "sign with your phone", () =>
        known ? usePhone(known) : askPhone(),
      ),
    );
    if (known) el.append(" ", button("change", askPhone));
    if (availableWallets().length === 0)
      el.append(" no EIP-12 wallet found (install Nautilus, or sign with your phone)");
  }

  store.subscribe("wallet", render);
  render();
}
