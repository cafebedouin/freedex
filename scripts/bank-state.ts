import { Explorer } from "../src/explorer.ts";
import { loadBank, mintQuote } from "../src/protocols/sigmausd/bank.ts";
const b = await loadBank(new Explorer());
console.log(
  "oracle nanoERG/cent",
  b.oracleRate,
  "ratio",
  b.reserveRatio + "%",
  "reserves ERG",
  b.baseReserves / 1_000_000_000n,
  "SigUSD circ",
  b.circulatingStableCoins,
  "SigRSV circ",
  b.circulatingReserveCoins,
);
console.log(
  "mintable SigUSD",
  b.availableStableCoins,
  "SigRSV",
  b.availableReserveCoins,
  "| SigRSV price nanoERG",
  b.reserveCoinPrice,
);
const q = mintQuote(b, "reserve", 100n);
console.log("mint 100 SigRSV costs", q.erg, "nanoERG, allowed", q.allowed, "ratio after", q.reserveRatioAfter);
