// Chain upkeep while a wallet is connected: every few minutes the keyless jobs (Babel bids and Machina orders priced
// across their pool, submitted with no signature, bounty to the visitor), then the one job that needs the visitor's
// wallet: a matured SigmaFi bond whose lender is the visitor, whose collateral the page hands to them. The contract
// path is keyless; the miner fee comes from the visitor's change, so the wallet is asked to sign, once per bond.
import { buildLiquidate } from "../bonds";
import { maturedBondsFor, runUpkeep } from "../upkeep";
import { $, err, log } from "./dom";
import type { Store } from "./store";
import { send } from "./wallet";

export const UPKEEP_EVERY_MS = 3 * 60 * 1000;

export function mountUpkeep(store: Store) {
  let timer: number | undefined;
  let busy = false;
  /** bonds the wallet was already asked about this session */
  const asked = new Set<string>();
  /** boxes the keyless jobs spent lately, so a transaction still in the mempool is not repeated */
  const recent = new Map<string, number>();
  const onEl = $<HTMLInputElement>("upkeep-on");
  const status = $("upkeep-status");

  async function tick() {
    const wallet = store.wallet;
    if (!onEl.checked || !wallet || busy) return;
    busy = true;
    try {
      const r = await runUpkeep(store.explorer, wallet.changeAddress, log, recent);
      let collateral = 0;
      const due = await maturedBondsFor(store.explorer, await store.explorer.height(), wallet.usedAddresses);
      for (const { box, v } of due) {
        if (asked.has(box.boxId)) continue;
        asked.add(box.boxId);
        try {
          const id = await send(store, (height, inputs) =>
            buildLiquidate({ height, inputs, recipient: wallet.changeAddress, bondBox: box }),
          );
          collateral++;
          log(
            `upkeep lender-collateral: bond ${v.boxId.slice(0, 8)} matured at ${v.maturity}; its collateral to you; submitted ${id}`,
          );
        } catch (e) {
          log(`upkeep lender-collateral: bond ${v.boxId.slice(0, 8)}; not submitted (${err(e)})`);
        }
      }
      status.textContent = `(last check ${new Date().toISOString().slice(11, 16)} UTC: ${r.found + due.length} due, ${r.submitted.length + collateral} submitted)`;
    } catch (e) {
      status.textContent = `(upkeep: ${err(e)})`;
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(() => void tick(), UPKEEP_EVERY_MS);
    void tick();
  }

  onEl.onchange = () => {
    status.textContent = "";
    if (onEl.checked) schedule();
  };
  store.subscribe("wallet", () => {
    if (store.wallet) schedule();
  });
  return { tick };
}
