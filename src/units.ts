// Decimal text <-> smallest units, exact. No floating point anywhere near a transaction.
export const ERG_DECIMALS = 9;

export function parseUnits(text: string, decimals: number): bigint {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2])) throw new Error(`not a number: "${text}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals`);
  return BigInt((m[1] || "0") + frac.padEnd(decimals, "0"));
}

export function formatUnits(x: bigint, decimals: number, maxFrac = decimals): string {
  const neg = x < 0n;
  if (neg) x = -x;
  let s: string;
  if (decimals === 0) s = x.toString();
  else {
    const t = x.toString().padStart(decimals + 1, "0");
    let frac = t.slice(-decimals).slice(0, maxFrac).replace(/0+$/, "");
    s = t.slice(0, -decimals) + (frac ? "." + frac : "");
  }
  return (neg ? "-" : "") + s;
}

/** price register (nanoERG per smallest unit) shown as ERG per whole token */
export function priceToErgPerToken(price: bigint, decimals: number): string {
  return formatUnits(price * 10n ** BigInt(decimals), ERG_DECIMALS);
}

/** ERG per whole token (text) to the price register; refuses a price that is not a whole number of nanoERG per unit */
export function ergPerTokenToPrice(text: string, decimals: number): bigint {
  const nano = parseUnits(text, ERG_DECIMALS);
  const unitsPerToken = 10n ** BigInt(decimals);
  if (nano % unitsPerToken !== 0n)
    throw new Error(`price must be a multiple of ${formatUnits(unitsPerToken, ERG_DECIMALS)} ERG per token (the contract's price is an integer per smallest unit)`);
  return nano / unitsPerToken;
}
