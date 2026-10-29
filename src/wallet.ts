// EIP-12 connection to a browser wallet (Nautilus, SAFEW). The page never sees a key.
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import type { EIP12ErgoAPI } from "@nautilus-js/eip12-types";

export interface Wallet {
  name: string;
  api: EIP12ErgoAPI;
  changeAddress: ErgoAddress;
  usedAddresses: string[];
}

export function availableWallets(): string[] {
  if (typeof ergoConnector === "undefined" || !ergoConnector) return [];
  return Object.keys(ergoConnector);
}

export async function connect(name: string): Promise<Wallet> {
  if (typeof ergoConnector === "undefined" || !ergoConnector) throw new Error("no EIP-12 wallet found");
  const connector = ergoConnector[name];
  if (!connector) throw new Error(`wallet "${name}" not found`);
  const ok = await connector.connect({ createErgoObject: false });
  if (!ok) throw new Error("connection refused");
  const api = await connector.getContext();
  const change = await api.get_change_address();
  return {
    name,
    api,
    changeAddress: ErgoAddress.fromBase58(change),
    usedAddresses: await api.get_used_addresses(),
  };
}

export async function disconnect(name: string): Promise<void> {
  if (typeof ergoConnector === "undefined" || !ergoConnector) return;
  await ergoConnector[name]?.disconnect();
}

export async function utxos(w: Wallet): Promise<Box<string>[]> {
  return (await w.api.get_utxos()) as unknown as Box<string>[];
}

export async function signAndSubmit(w: Wallet, tx: EIP12UnsignedTransaction): Promise<string> {
  const signed = await w.api.sign_tx(tx as Parameters<EIP12ErgoAPI["sign_tx"]>[0]);
  return w.api.submit_tx(signed);
}
