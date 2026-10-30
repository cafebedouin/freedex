# Pools: ErgoDEX v1 swaps, deposits and redemptions

Modules: `src/protocols/ergodex/amm.ts` (ERG pools and token-to-token pools). Registry: `ergodex-n2t-pool`
(`2dcc7830afe8`), `ergodex-t2t-pool` (`3c09deff3b5f`). Tests: `src/protocols/ergodex/amm.test.ts`,
`liquidity.test.ts`, `t2t.test.ts`; `test/properties/pools.test.ts`.

The contract quoted below is `contracts/amm/cfmm/v1/n2t/Pool.sc` and `.../t2t/Pool.sc` of
`spectrum-finance/ergo-dex` at commit `8fe94e1`, fetched 2026-10-29; the deployed trees are the ones in the registry
(read from the chain, not recompiled here). Both scripts share the same `validSwap`, `validDepositing` and
`validRedemption` lines; the differences are listed under T2T. In every formula `x` and `y` are the reserves before
the transaction, `feeNum` is R4, `FeeDenom = 1000`, `supply = 0x7fffffffffffffff - reservedLP` (`InitiallyLockedLP`
minus the LP tokens left in the box; `lpSupply`, `amm.ts:128`).

What every pool transaction shares (the contract, both scripts):

- the successor is `OUTPUTS(0)` (`val successor = OUTPUTS(0)`), so a transaction moves exactly one pool, and every
  builder here puts the pool box at `INPUTS(0)` and its successor at output 0 (`amm.ts:117`, `:179`, `:213`,
  `:313`, `:358`, `:381`);
- `validSuccessorScript`, `preservedFeeConfig` (R4 copied), `preservedPoolNFT`, `validLP`, `validY` (the token ids at
  the same positions); N2T adds `noMoreTokens` (`successor.tokens.size == 3`) and `validStorageRent`
  (`successor.value > MinStorageRent`, `MinStorageRent = 10000000L`, strict); T2T adds `preservedErgs`
  (`ergs1 >= ergs0`) and `validPair` instead;
- `validAction`: `deltaSupplyLP == 0` means a swap; a positive change in both reserves with LP unlocked is a deposit;
  anything else is judged as a redemption.

## `describePool` / `describeT2TPool`

1. Throws `not an N2T pool box` (tree differs from the registry's), `pool box must hold NFT, LP token and the token`
   (not three assets), `pool box has no R4`; T2T: `not a T2T pool box`, `T2T pool box must hold NFT, LP token and
two tokens` (not four), `pool box has no R4` (`amm.ts:35-38`, `:247-250`).
2. Everything is read from the chain box. The N2T R4 is read as `SConstant.from<number>` (an Int), the T2T R4 as
   `number | bigint` (`amm.ts:47`, `:260`): the deployed T2T tree reads `SELF.R4[Int]` although the repository's
   `t2t/Pool.sc` says `SELF.R4[Long].get` (its line 2); the comment at `amm.ts:226-227` records the same finding.
   The N2T source says `SELF.R4[Int].get`, consistent.
3. No arithmetic.
4. Nothing: a box that passes `describePool` but is not a pool (wrong NFT position, say) is refused by the explorer
   listing's shape filter (`explorer.ts` keeps three-asset boxes under the template hash) and, if built against,
   by the pool script's `preservedPoolNFT`.
5. `test/explorer.test.ts` "a real pool box from the explorer re-hashes to its own id after conversion".
6. The explorer's listing is cached 30 s (`CACHE_MS`); every builder on the page is handed a box re-read by NFT
   right before the build (`poolByNft`, below).

## `quote` and `quoteT2T`

1. `amountIn <= 0n` returns `0n`; nothing is thrown. `quoteT2T` throws `token is not in this pool` through
   `t2tSides` (`amm.ts:269`).
2. The user sets `amountIn`; `x`, `y`, `feeNum` come from the box.
3. ERG to token: `out = floor(y * amountIn * feeNum / (x * 1000 + amountIn * feeNum))`; token to ERG and T2T the
   same with the sides swapped (`amm.ts:56-57`, `:275`). This is the largest `out` the contract accepts: with
   `deltaReservesX = amountIn` and `deltaReservesY = -out`, `validSwap` reads
   `reservesY0.toBigInt * deltaReservesX * feeNum0 >= -deltaReservesY * (reservesX0.toBigInt * FeeDenom + deltaReservesX * feeNum0)`,
   so `out <= y * dx * feeNum / (x * 1000 + dx * feeNum)` and the floor is the bound. Rounded against the taker.
4. Nothing beyond the bound itself.
5. `amm.test.ts` "ERG to token at the pool's rule" (asserts the formula), "token to ERG at the pool's rule";
   `t2t.test.ts` "swaps X for Y and Y for X at the pool's rule"; one unit more: `amm.test.ts` "taking one token
   more than the rule allows is refused by the pool", `t2t.test.ts` "the pool refuses one token too many".
6. `priceImpactBps` compares `out` with `floor(y * amountIn * feeNum / (x * 1000))`, the fee-adjusted spot, in
   basis points rounded down (`amm.ts:61-69`, `:278-284`); it is display only.

## `buildSwap` and `buildSwapT2T`

1. Throws `the amount times the pool's fee numerator does not fit a Long: the pool script cannot evaluate it`
   (`amountIn * feeNum > 2^63 - 1`; added 2026-10-29, see 4), `the trade is too small to receive anything`
   (`out <= 0`), `the pool would pay ${out}, below the minimum ${minOut}` (the slippage guard), `the trade would take the pool to its minimum ERG or below`
   (N2T, `x + dx <= 10_000_000`, mirroring the strict `validStorageRent`), `the trade would empty the pool's token`
   (N2T, `y + dy <= 0`), `the trade would empty the pool` (T2T, either reserve at 0) (`amm.ts:95-100`, `:314-320`).
2. The user sets the direction, `amountIn` (typed, parsed exactly by `parseUnits`) and the slippage tolerance;
   `minOut` is computed on the page from the quote the user saw (`src/ui/swap.ts`) and kept until the
   amount changes; the pool box is re-read by NFT at `src/ui/swap.ts` (`poolByNft` or `t2tPoolByNft`) right
   before the build, so `out` is the fresh pool's figure and `minOut` the shown one. See `signing.md` for the
   stale-quote refusal ("the quote is stale").
3. `out = quote(...)` as above; the successor holds `x + dx` and `y + dy`, the LP amount copied from the input
   box (`BigInt(p.poolBox.assets[1].amount)`, so `deltaSupplyLP == 0`), R4 copied; the user's output carries `out`
   (a 0.001 ERG box when tokens are received). Fee 0.001 ERG (`FEE`), change to the user.
4. The contract also refuses a successor with a changed fee numerator, NFT, LP id or token id, a fourth token
   (N2T), or a lower ERG value (T2T `preservedErgs`); the builder constructs these from the input and does not
   re-check them. Found by `test/properties/pools.test.ts` on 2026-10-29 and now pre-checked: `validSwap` computes
   `deltaReservesX * feeNum0` (a Long times an Int, or a Long in T2T) before any `.toBigInt`, so an input above
   `(2^63 - 1) / feeNum` (about 9.2 million ERG, or 9.2e15 token units) makes the script throw `long overflow`
   (sigmastate-js, `java.lang.ArithmeticException`) and the node would reject the transaction with no refusal from
   the page; the builders now throw first (`amm.ts`, the `LONG_MAX` check). The quote itself is exact at any size.
5. `amm.test.ts` "taking one token more than the rule allows is refused by the pool", "the slippage guard refuses a
   stale quote" (builder, `minOut = out + 1`); `t2t.test.ts` "the pool refuses one token too many";
   `test/properties/pools.test.ts` "an input the pool script cannot multiply by its fee numerator in a Long is
   refused by the builder, not the node".
6. The pool the builder saw and the pool the node validates against differ by whatever lands in between: a
   swap mined after another trade on the same box is simply invalid (the input is spent), never mispriced. The
   mock chain evaluates at `height + 1`; the pool script has no height term.

## `depositQuote`, `depositQuoteFromTokens`, `depositQuoteT2T`, `depositQuoteT2TFromY`

1. A non-positive input returns zeros; nothing thrown.
2. The user types one side; the other is derived (`src/ui/pool.ts`, `depositAmounts`); reserves and `supply`
   from the box.
3. ERG first: `tokenIn = ceil(ergIn * y / x)` (`(ergIn * p.y + p.x - 1n) / p.x`, `amm.ts:135`), then
   `lpOut = min(floor(ergIn * supply / x), floor(tokenIn * supply / y))` (`:130`). Tokens first:
   `ergIn = ceil(tokenIn * x / y)` (`:137`), same `lpOut`. T2T the same with `x`, `y` as the two token reserves
   (`:325-337`). The contract: `validDepositing` is
   `deltaSupplyLP <= min(deltaReservesX.toBigInt * supplyLP0 / reservesX0, deltaReservesY.toBigInt * supplyLP0 / reservesY0)`,
   integer division in BigInt, so `lpOut` is exactly the bound (rounded against the depositor); the other side's
   amount is rounded up so the typed side binds.
4. Nothing further.
5. `liquidity.test.ts` "deposit earns LP at the pool's ratio, then redeem returns the share" (the figures), "the pool
   refuses a deposit that claims one LP token too many"; `t2t.test.ts` "deposit then redeem returns the share";
   "deposit quotes agree from either side" > "tokens-first gives the ERG that ERG-first would have asked for the
   same tokens"; `test/properties/pools.test.ts` (the agreement across drawn pools).
6. The two directions agree to within one rounding step, and that is what `test/properties/pools.test.ts` checks:
   with `tokenIn = ceil(e * y / x)` and `e' = depositQuoteFromTokens(tokenIn).ergIn = ceil(tokenIn * x / y)`,
   `e <= e' <= e + ceil(x / y)`, `lpOut' >= lpOut`, and `depositQuote(e').tokenIn` is within `ceil(y / x)` of
   `tokenIn`; `e' = e` exactly when the ratio divides (the example in `liquidity.test.ts`). Both are the pool's
   own `min` rule at their pair. `lpOut` can be 0 for a tiny deposit, refused by the builder (next section).

## `buildDeposit` and `buildDepositT2T`

1. Throws `the deposit is too small to earn any LP token` (`lpOut <= 0`) (`amm.ts:168`, `:365`).
2. The user's ERG (or X) amount; the box re-read by NFT at `src/ui/pool.ts` (`poolByNft` or `t2tPoolByNft`); the quote is recomputed
   against the fresh box, so the token side may differ from what was shown if the pool moved (the page recomputes
   through `depositAmounts` with the fresh entry at `:248` / `:252`).
3. Successor: `x + ergIn`, `y + tokenIn`, LP reserved `lpReserved - lpOut`; the user's output carries `lpOut` LP
   tokens in a 0.001 ERG box.
4. The contract refuses a successor whose LP unlock exceeds the bound, or whose ERG value is not above the
   minimum (always true here, the value grows).
5. `liquidity.test.ts` "the pool refuses a deposit that claims one LP token too many" (one LP token moved from the
   successor to the user).
6. The wallet must hold `tokenIn` at the pool's ratio; Fleet's selector fails the build (not the contract) when
   it does not, and the page tells the user before signing (README "Units and limits").

## `redeemQuote`, `redeemQuoteT2T`, `buildRedeem`, `buildRedeemT2T`

1. Quotes return zeros for `lpIn <= 0`. `buildRedeem` throws `the redemption is too small to return anything`
   (both outputs 0) and `the redemption would take the pool to its minimum ERG or below` (`x - ergOut <= 10^7`)
   (`amm.ts:197-199`); `buildRedeemT2T` throws only the first (`:385`): its ERG value is preserved, not a reserve.
2. The user's `lpIn` (whole units, `parseUnits(text, 0)`); the box re-read at `src/ui/pool.ts` (`poolByNft` or `t2tPoolByNft`).
3. `ergOut = floor(lpIn * x / supply)`, `tokenOut = floor(lpIn * y / supply)` (`amm.ts:153-154`, `:352-353`).
   The contract: `validRedemption` is
   `deltaReservesX.toBigInt * supplyLP0 >= _deltaSupplyLP * reservesX0 && deltaReservesY.toBigInt * supplyLP0 >= _deltaSupplyLP * reservesY0`
   with all three deltas negative, i.e. `ergOut * supply <= lpIn * x` and the same for `y`, so the floors are the
   bounds. Rounded against the redeemer. The successor keeps `lpReserved + lpIn`.
4. The N2T contract also refuses a successor at or below `MinStorageRent`, which the builder pre-checks; a
   redemption that returns 0 ERG but some tokens is allowed by the contract and the builder tops the user's box
   to 0.001 ERG from change (`amm.ts:207`).
5. `liquidity.test.ts` "the pool refuses a redemption that takes one nanoERG too many"; `t2t.test.ts` "deposit then
   redeem returns the share".
6. None beyond the shared ones.

Properties: `test/properties/pools.test.ts` (quote at the bound over reserves to 2^62, swap at the quote executes on
the mock chain, `minOut + 1` refused by the builder, the Long guard, ERG-first and tokens-first deposit quotes
agree, a deposit from either side executes and the redeem quote stays within the share).
