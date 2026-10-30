// The Bank tab: mint or redeem SigUSD and SigRSV against the SigmaUSD bank through Fleet's AgeUSD plugin.
import { SIGRSV_ID, SIGUSD_ID, buildMint, buildRedeem, mintQuote, redeemQuote } from "../protocols/sigmausd/bank";
import { ERG_DECIMALS, formatUnits, parseUnits } from "../units";
import { $, dl, err, log } from "./dom";
import type { Store } from "./store";
import { send } from "./wallet";

export function mountBank(store: Store) {
  async function renderBank() {
    try {
      dl($("bank-info"), [["Bank", store.explorerLabel()]]);
      const bank = await store.loadBank();
      const usdPerErg = bank.oracleRate; // nanoERG per cent
      dl($("bank-info"), [
        ["Oracle", `${formatUnits(usdPerErg * 100n, ERG_DECIMALS, 4)} ERG per USD`],
        ["Reserve ratio", `${bank.reserveRatio}%`],
        ["Reserves", `${formatUnits(bank.baseReserves, ERG_DECIMALS, 0)} ERG`],
        ["SigUSD in circulation", formatUnits(bank.circulatingStableCoins, 2)],
        ["SigRSV in circulation", bank.circulatingReserveCoins.toString()],
        ["SigUSD price", `${formatUnits(bank.stableCoinPrice * 100n, ERG_DECIMALS, 4)} ERG`],
        ["SigRSV price", `${formatUnits(bank.reserveCoinPrice, ERG_DECIMALS, 6)} ERG`],
        ["Mintable now", `${formatUnits(bank.availableStableCoins, 2)} SigUSD, ${bank.availableReserveCoins} SigRSV`],
      ]);
      renderBankQuote();
    } catch (e) {
      dl($("bank-info"), [["Bank", `explorer unavailable (${err(e)}); open the tab again to retry`]]);
    }
  }

  function bankSelection(): { action: "mint" | "redeem"; coin: "stable" | "reserve"; tokenId: string; dec: number } {
    const [action, coin] = $<HTMLSelectElement>("bank-action").value.split(":") as [
      "mint" | "redeem",
      "stable" | "reserve",
    ];
    return { action, coin, tokenId: coin === "stable" ? SIGUSD_ID : SIGRSV_ID, dec: coin === "stable" ? 2 : 0 };
  }

  function renderBankQuote() {
    const btn = $<HTMLButtonElement>("bank-go");
    btn.disabled = true;
    const sel = bankSelection();
    $("bank-amount-name").textContent = sel.coin === "stable" ? "SigUSD" : "SigRSV";
    const bank = store.state.bank;
    if (!bank) return;
    try {
      const text = $<HTMLInputElement>("bank-amount").value.trim();
      if (!text) {
        dl($("bank-quote"), []);
        return;
      }
      const amount = parseUnits(text, sel.dec);
      const q = sel.action === "mint" ? mintQuote(bank, sel.coin, amount) : redeemQuote(bank, sel.coin, amount);
      dl($("bank-quote"), [
        [
          sel.action === "mint" ? "You pay (all fees in)" : "You receive (all fees out)",
          `${formatUnits(q.erg, ERG_DECIMALS)} ERG`,
        ],
        ["Reserve ratio after", `${q.reserveRatioAfter}%`],
        ["Allowed by the bank", q.allowed ? "yes" : "no (the ratio would leave the band)"],
      ]);
      btn.textContent = store.wallet ? (sel.action === "mint" ? "Mint" : "Redeem") : "Connect a wallet";
      btn.disabled = !store.wallet || !q.allowed;
    } catch (e) {
      dl($("bank-quote"), [["Amount", err(e)]]);
    }
  }

  $<HTMLSelectElement>("bank-action").onchange = renderBankQuote;
  $<HTMLInputElement>("bank-amount").oninput = renderBankQuote;
  $<HTMLButtonElement>("bank-go").onclick = async () => {
    try {
      const sel = bankSelection();
      const amount = parseUnits($<HTMLInputElement>("bank-amount").value, sel.dec);
      const fresh = await store.loadBank();
      const build = sel.action === "mint" ? buildMint : buildRedeem;
      const user = store.wallet!.changeAddress;
      const q = sel.action === "mint" ? mintQuote(fresh, sel.coin, amount) : redeemQuote(fresh, sel.coin, amount);
      const coin = sel.coin === "stable" ? "SigUSD" : "SigRSV";
      const what =
        sel.action === "mint"
          ? `Mint ${formatUnits(amount, sel.dec)} ${coin} from the bank for ${formatUnits(q.erg, ERG_DECIMALS)} ERG, the bank's 2% fee and the miner fee included`
          : `Redeem ${formatUnits(amount, sel.dec)} ${coin} at the bank for ${formatUnits(q.erg, ERG_DECIMALS)} ERG, the bank's 2% fee and the miner fee taken out`;
      await send(store, (height, inputs) => build({ height, inputs, user, bank: fresh, coin: sel.coin, amount }), what);
      $<HTMLInputElement>("bank-amount").value = "";
      setTimeout(() => void renderBank(), 3000);
    } catch (e) {
      log(`bank failed: ${err(e)}`);
    }
  };

  return { show: () => void renderBank() };
}
