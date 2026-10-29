// The header's wallet control (connect, disconnect) and `send`, the one path every tab's transaction takes:
// build from the wallet's boxes at the wallet's height, sign in the wallet, submit from the wallet.
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { availableWallets, connect, disconnect, signAndSubmit, utxos } from "../wallet";
import { $, err, log } from "./dom";
import type { Store } from "./store";

export type Builder = (height: number, inputs: Box<string>[]) => EIP12UnsignedTransaction;

export async function send(store: Store, build: Builder): Promise<string> {
  const wallet = store.wallet;
  if (!wallet) throw new Error("connect a wallet first");
  const height = await wallet.api.get_current_height();
  const inputs = await utxos(wallet);
  const tx = build(height, inputs);
  log(`built: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs, height ${height}; waiting for the wallet`);
  const txId = await signAndSubmit(wallet, tx);
  log(`submitted ${txId}\n${store.explorer.txUrl(txId)}`);
  store.explorer.invalidate();
  return txId;
}

export function mountWallet(store: Store) {
  const el = $<HTMLDivElement>("wallet");

  function render() {
    el.replaceChildren();
    const wallet = store.wallet;
    if (wallet) {
      const addr = wallet.changeAddress.encode();
      el.append(`${wallet.name}: ${addr.slice(0, 8)}…${addr.slice(-6)} `);
      const b = document.createElement("button");
      b.textContent = "disconnect";
      b.onclick = async () => {
        await disconnect(wallet.name);
        store.setWallet(undefined);
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
          const w = await connect(name);
          log(`connected ${name}, change address ${w.changeAddress.encode()}`);
          store.setWallet(w);
        } catch (e) {
          log(`connect failed: ${err(e)}`);
          store.setWallet(undefined);
        }
      };
      el.append(b, " ");
    }
  }

  store.subscribe("wallet", render);
  render();
}
