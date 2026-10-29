// What every tab signs with. Two kinds: a browser wallet over EIP-12 (Nautilus, SAFEW), which holds the keys, gives
// the boxes and balances, signs and submits; and a phone over ErgoPay (`ergopay.ts`), where the page reads boxes and
// balances from the explorer by address and the phone signs a reduced transaction from a QR code. The page never
// sees a key on either path.
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress } from "@fleet-sdk/core";
import type { EIP12ErgoAPI } from "@nautilus-js/eip12-types";

export type SignerKind = "eip12" | "ergopay";

export interface Signer {
  kind: SignerKind;
  /** "nautilus", "safew", "phone" */
  name: string;
  changeAddress: ErgoAddress;
  usedAddresses: string[];
  /** the height to build at */
  height(): Promise<number>;
  /** the boxes a builder may spend, in the EIP-12 shape (amounts as strings) */
  utxos(): Promise<Box<string>[]>;
  /** nanoERG for "ERG", else the token's raw amount */
  balance(tokenId: string): Promise<bigint>;
  /** signs and submits; resolves with the transaction id */
  sign(tx: EIP12UnsignedTransaction): Promise<string>;
  disconnect(): Promise<void>;
}

/** The store's name for the connected signer. */
export type Wallet = Signer;

export function availableWallets(): string[] {
  if (typeof ergoConnector === "undefined" || !ergoConnector) return [];
  return Object.keys(ergoConnector);
}

export async function connect(name: string): Promise<Signer> {
  if (typeof ergoConnector === "undefined" || !ergoConnector) throw new Error("no EIP-12 wallet found");
  const connector = ergoConnector[name];
  if (!connector) throw new Error(`wallet "${name}" not found`);
  const ok = await connector.connect({ createErgoObject: false });
  if (!ok) throw new Error("connection refused");
  const api: EIP12ErgoAPI = await connector.getContext();
  const change = await api.get_change_address();
  return {
    kind: "eip12",
    name,
    changeAddress: ErgoAddress.fromBase58(change),
    usedAddresses: await api.get_used_addresses(),
    height: () => api.get_current_height(),
    utxos: async () => (await api.get_utxos()) as unknown as Box<string>[],
    balance: async (tokenId) => BigInt(await api.get_balance(tokenId)),
    sign: async (tx) => {
      const signed = await api.sign_tx(tx as Parameters<EIP12ErgoAPI["sign_tx"]>[0]);
      return api.submit_tx(signed);
    },
    disconnect: async () => {
      await ergoConnector?.[name]?.disconnect();
    },
  };
}
