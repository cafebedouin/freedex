// Shared settings for the property suites: one seed for every run (reproducible; FC_SEED overrides it), the run
// counts printed so the record can quote them, and the generators the suites share.
import fc from "fast-check";

/** Today's date as the seed; every suite prints it beside its run count. */
export const SEED = Number(import.meta.env.FC_SEED ?? 20261029);
fc.configureGlobal({ seed: SEED, endOnFailure: true });

export const LONG_MAX = 9_223_372_036_854_775_807n;
export const TWO_62 = 2n ** 62n;

/** A bigint in [lo, hi]. */
export const big = (lo: bigint, hi: bigint) => fc.bigInt({ min: lo, max: hi });

/** Reserves up to 2^62 (nanoERG or token units), fee numerators from 0.1% to 1% (ErgoDEX pools use 990 to 999). */
export const reserve = big(1n, TWO_62);
export const feeNum = big(990n, 999n);

export function report(name: string, numRuns: number) {
  console.log(`property ${name}: ${numRuns} runs, seed ${SEED}`);
}
