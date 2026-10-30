// The page: one store for what the tabs share, one module per tab, the tab switcher, and the boot sequence.
import { Explorer, storedExplorer } from "./explorer";
import { mountBank } from "./ui/bank";
import { mountBonds } from "./ui/bonds";
import { $, err, log } from "./ui/dom";
import { mountEscrow } from "./ui/escrow";
import { mountHeader } from "./ui/header";
import { mountOptions } from "./ui/options";
import { mountOrders } from "./ui/orders";
import { mountPool } from "./ui/pool";
import { mountPrograms } from "./ui/programs";
import { Store } from "./ui/store";
import { mountSwap } from "./ui/swap";
import { mountUpkeep } from "./ui/upkeep";
import { mountWallet } from "./ui/wallet";

const store = new Store(new Explorer(storedExplorer() ?? import.meta.env.VITE_EXPLORER ?? undefined));
const explorer = store.explorer;

mountHeader(store);
mountWallet(store);
const orders = mountOrders(store);
const tabs: Record<string, { show?: () => void; load?: () => Promise<void> }> = {
  swap: mountSwap(store),
  orders,
  pool: mountPool(store),
  bank: mountBank(store),
  bonds: mountBonds(store),
  escrow: mountEscrow(store),
  programs: mountPrograms(store),
  options: mountOptions(store),
};
mountUpkeep(store);

// ---- tabs --------------------------------------------------------------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>("nav [role=tab]")) {
  b.onclick = () => {
    for (const o of document.querySelectorAll<HTMLButtonElement>("nav [role=tab]"))
      o.setAttribute("aria-selected", String(o === b));
    for (const name of Object.keys(tabs)) $(`tab-${name}`).hidden = name !== b.dataset.tab;
    tabs[b.dataset.tab!]?.show?.();
  };
}

// ---- boot --------------------------------------------------------------------------------------

// the pool listing is what the Swap and Pool tabs stand on: keep asking until it loads (the explorer retries each
// request itself; this is the slower loop between refreshes)
const POOLS_RETRY_MS = 30_000;
const loadPools = () => {
  void store.loadPools().then((ok) => {
    if (!ok) setTimeout(loadPools, POOLS_RETRY_MS);
  });
};
loadPools();
void store.loadBank().catch((e) => log(`bank: ${err(e)}`));
void orders.load();
explorer
  .height()
  .then((h) => log(`explorer ${explorer.base}, height ${h}`))
  .catch((e) => log(`explorer: ${err(e)}`));
