# The clocked box: invariants

Modules: `src/protocols/clock/clock.ts` against `contracts/Clock.es` (buy) and `contracts/ClockSell.es` (sell); registry
entries `clock-buy` (`a1df056602fa…`, 504 bytes) and `clock-sell` (`7bf4e2d6ba91…`, 517 bytes); tests
`src/protocols/clock/clock.test.ts` (buy cases, then the sell cases mirrored), `test/hashes.test.ts` (recompiles
both sources), `test/properties/clock.test.ts`; the page's call sites `src/ui/programs.ts` and the keyless executor
`src/upkeep.ts` (`clockLegs`) with `scripts/upkeep-run.ts`.

Constants (`clock.ts:38-48`): `CLOCK_SLACK` 4 blocks (substituted for `$SLACK` before compiling), `RENT_PERIOD`
1,051,200 blocks, `STORAGE_FEE_FACTOR` 1,250,000 nanoERG per byte per period (mainnet `storageFeeFactor`,
2026-10-29), `MIN_VALUE_PER_BYTE` 360, `OWNER_BOX_VALUE` 100,000 nanoERG, `FEE` 1,000,000 (`machina/orders.ts`).

The mock chain evaluates a transaction at `HEIGHT = chain.height + 1`, as a node checks the next block
(`clock.test.ts:3-5`); every "at height" below is the build height `h`, and the script sees `h + 1`.

## `describeClock` (`clock.ts:83`)

1. Throws `not a clocked box` (tree is neither pinned tree), `clocked box lacks a register` (R4 to R7),
   `clocked box R7 must hold six parameters`, `sell program does not hold its token first` (`clock.ts:86-104`).
2. Everything is read from the box: owner (R4), token (R5), pool NFT (R6), `(slice, interval, toleranceBps,
executorFee, price, rentReserve)` (R7), value, tokens, `creationHeight`. `dueAt = creationHeight + interval`.
3. Buy: `last = value - rentReserve - slice - executorFee < slice + executorFee`, the script's `budgetAfter < slice
   - executorFee` (`Clock.es:60-61`); `legsLeft = floor((value - rentReserve) / (slice + executorFee))`, at least 1
while `value > executorFee`. Sell: `last = tokens - slice < slice` (`ClockSell.es:55`); `legsLeft =
     floor(tokens / slice)`, 1 when `last`.
4. Nothing: a describer. A box under either tree with a malformed R7 (made by another tool) is skipped by the
   listings and the upkeep job (`src/ui/programs.ts`, `src/upkeep.ts` `clockLegs`, the `try` around it).
5. Covered by the `create` helper's assertions on every case (`clock.test.ts:98-116`, `407-432`).
6. `maxPrice` is only meaningful on the buy side and `minPrice` on the sell side; the view zeroes the other.

## `sizeProgram` and `buildCreateClock` (buy; `clock.ts:203`, `267`)

1. `checkCommon` (`clock.ts:181-192`): `the pool does not hold the program's token`, `legs must be a whole number of
at least 1`, `interval must be a whole number of blocks`, `legs x interval must stay within one storage-rent
period (1051200 blocks)`, `tolerance must be 0 to 10000 basis points`, `executorFee must exceed the miner fee plus
the owner's output (1100000 nanoERG), or no one can run a leg`. Then `slice must be positive`, `maxPrice must be 0
(none) or positive`. `registersOf` throws `the owner must be a P2PK address` (`clock.ts:161`).
2. User: slice, legs (the form takes an amount and derives `legs = amount / slice`, refusing a remainder with `the
amount must be a whole number of slices`, `src/ui/programs.ts`), interval, tolerance (percent with two
   decimals to basis points), cap (`unitPrice`, `programs.ts:68`: an integer in nanoERG per smallest unit or `the cap
must be a whole number of nanoERG per smallest unit`), executor fee. Chain: the deepest ERG pool for the token
   (`store.deepestPool`), re-read by NFT right before the build (`programs.ts:266`); its NFT is pinned in R6. Without
   a wallet the quote sizes the box with the curve's generator as the owner (`GENERATOR`, `programs.ts:34`, 92); it
   is never an output.
3. `value = legs x (slice + executorFee)`, exactly; `rentReserve = 0`. `bytes` from `estimateBoxSize` with
   `creationHeight = RENT_PERIOD x 4` (any height of today's encoded width) and `rentFeeWouldBe = bytes x
STORAGE_FEE_FACTOR`, for the quote only. The box's `creationHeight` is `height + 1` (`clock.ts:269`), the first
   block it can be mined in: `due` runs from there (`Clock.es:58`).
4. The contract runs no check at creation (the box is an output of the owner's key spend). What the script will
   later refuse that the sizing does not catch: a program whose `slice + executorFee` is below what the pool's
   rule can deliver one token for (`got` then 0 and the owner's output cannot carry the token; the leg builder
   returns `undefined` on `got <= 0`, `clock.ts:355`).
5. `clock.test.ts` "sizes the program: legs x (slice + fee), no rent reserve on the buy side; refuses a schedule
   past a rent period".
6. No rent reserve on the buy side: an ERG-only box left a rent period loses one `rentFeeWouldBe` to the claim and
   continues as a smaller program (a box smaller than the fee is consumed); the schedule bound keeps a program that
   runs on time inside the period. A buy program's bytes are 666 on mainnet (README, "Units and limits").

## `sizeProgramSell` and `buildCreateClockSell` (sell; `clock.ts:228`, `284`)

1. `slice must be positive`, `the amount must be at least one slice`, `minPrice must be 0 (none) or positive`, then
   `checkCommon` with `legs = floor(tokens / slice)`.
2. User: tokens, slice (both in the token's smallest units), interval, tolerance, floor (`unitPrice`), executor
   fee. Chain: the pool as above. The remainder `tokens - legs x slice` is sold with the last leg.
3. `value = legs x executorFee + rentReserve + minBox`, where `rentReserve = bytes x STORAGE_FEE_FACTOR` and
   `minBox = bytes x MIN_VALUE_PER_BYTE`, iterated at most four times to a fixed point because the value's own
   encoding changes `bytes` (`clock.ts:245-257`); the loop stops when the reserve repeats. Registers carry
   `rentReserve` in R7(5).
4. As the buy side: nothing at creation.
5. `clock.test.ts` "sizes the program: legs x fee plus one storage-rent fee for the box's bytes plus the node's
   minimum; legs from the tokens".
6. A token box that cannot pay its rent is consumed whole, tokens included, so the sell side holds one full rent fee
   (0.89 ERG for 714 bytes on mainnet, README) and returns it with the last leg (`ClockSell.es:57`, `ergBack`).

## `sizeLeg` (`clock.ts:314`)

1. `the pool is not the program's pool` (NFT mismatch). No other throw: a leg that should not run is reported, not
   refused (`priceOk`, `payout`, `got`).
2. Everything from the two boxes: the pool's `x`, `y`, `feeNum` (R4 as `Int`, `ergodex/amm.ts` `describePool`) and
   the clock view. The executor fee goes to `payTo`, the upkeep runner's address.
3. Buy: `amt = last ? min(slice, value - executorFee) : slice` (`Clock.es:62`); `got = quote(pool, "erg-to-token",
amt) = floor(y x amt x feeNum / (x x 1000 + amt x feeNum))`, the script's `rule` (`Clock.es:69`), rounded down,
   so the builder's owner output is exactly the rule and `fillOk = got x 10000 >= rule x (10000 - toleranceBps)`
   (`Clock.es:70`) holds with tolerance 0. `priceOk = maxPrice == 0 || amt <= maxPrice x got`, the script's `capOk`
   (`Clock.es:71`). `ownerValue = last ? max(value - amt - executorFee, OWNER_BOX_VALUE) : OWNER_BOX_VALUE`;
   `payout = last ? value - amt - ownerValue - fee : executorFee - ownerValue - fee`. The script's last-leg check is
   `ownerOut.value >= SELF.value - amt - executorFee` (`Clock.es:79`); the `OWNER_BOX_VALUE` floor is the node's
   minimum for the owner's token box, paid out of the executor's fee.
   Sell: `amt = last ? tokens : slice` (`ClockSell.es:56`); `got = quote(pool, "token-to-erg", amt) = floor(x x amt
x feeNum / (y x 1000 + amt x feeNum))` (`ClockSell.es:64`); `priceOk = minPrice == 0 || got >= minPrice x amt`
   (`floorOk`, `ClockSell.es:66`); `ownerValue = last ? got + value - executorFee : max(got, OWNER_BOX_VALUE)`; the
   script reads `got = ownerOut.value - ergBack` with `ergBack = last ? SELF.value - executorFee : 0`
   (`ClockSell.es:57`, 63); `payout = executorFee - topUp - fee` where `topUp = ownerValue - got` on a leg that is
   not the last (`clock.ts:329-331`).
4. Not a builder; see `buildLeg`.
5. Buy: "a leg at the interval is accepted: the slice into the pool, the pool's rule to the owner, the fee to the
   executor, the clock restarted", "the last leg closes the box: no successor, the remainder to the owner". Sell:
   the mirrored case, "a slice whose proceeds are below the node's minimum: the owner's box is topped up out of the
   executor's fee", "a remainder smaller than a slice is sold with the last leg".
6. BigInt throughout, as `Pool.sc` does: `y x amt x feeNum` passes 2^63 on real pools (`Clock.es` header).

## `buildLeg` (`clock.ts:347`; keyless)

1. Returns `undefined`, not an error, when not due, `priceOk` false, `payout <= 0` or `got <= 0`
   (`clock.ts:354-355`); `force` builds anyway, for the script's own refusals. Throws `the leg would empty the pool`
   (buy, `got >= y`) and `the leg would take the pool to its minimum ERG` (sell, `x - got <= POOL_MIN_VALUE`).
2. No user input: the explorer's height, the pool box by NFT and the clock box (`src/upkeep.ts` `clockLegs`);
   `payTo` is the visitor's or the runner's address.
3. `due = height - creationHeight >= interval` at the build height `h`; the script's `due = (HEIGHT -
SELF.creationInfo._1) >= interval` at `HEIGHT = h + 1` (`Clock.es:58`). So the builder is one block later than
   the script requires: at `h = creationHeight + interval - 1` the script would accept and the builder waits; the
   upkeep job skips `height < dueAt` the same way. Inputs: pool at 0 (its own script makes OUTPUTS(0) its successor),
   the clock at 1 with context variable 0 = 1 (the owner's output index) and 1 = 2 (the successor) unless `last`
   (`clock.ts:371-381`). Outputs: pool successor (reserves moved, LP and R4 copied), the owner's box (`R4 = the
clock's id`, the token first on the buy side), the successor (every register copied, `value - slice -
executorFee` buy or `value - executorFee` sell, tokens `tokens - amt` sell, none buy, `creationHeight = h + 1`),
   the executor's payout, the miner fee. The script's successor bounds: `next.value >= SELF.value - slice -
executorFee` (`Clock.es:84`; sell `>= SELF.value - executorFee`, `ClockSell.es:78`), `next.tokens.size == 0`
   (buy) or `== 1` with `>= held - slice` of the token (sell, `ClockSell.es:79-81`), `next.creationInfo._1 >=
HEIGHT - 4` and `>= SELF.creationInfo._1 + interval` (`Clock.es:90-91`, `ClockSell.es:86-87`): a successor cannot
   be backdated past `SLACK` blocks and never before this leg's own due height.
4. Not pre-checked, refused by the script: a second clocked box in the same transaction (`onlyOne`, `Clock.es:59`);
   an owner's output below the rule less tolerance (`fillOk`); a payout above `executorFee` (through `next.value`
   or `ownerOut.value`); a backdated successor; the token missing from the owner's output (`ownerOut.tokens(0)._1
== tokenId`, `Clock.es:75`) or the wrong `R4`; a leg when `maxPrice`/`minPrice` bars it (`force` only); a leg one
   block early. Pre-checked by the builder but not by the script: the empty-pool and pool-minimum cases (those are
   the pool script's own refusals).
5. Buy (`clock.test.ts`): "a program built at H with interval N: its first leg is refused at HEIGHT H+N and
   accepted at H+N+1" (also shows the builder returning `undefined` at `h = built + N` while the forced leg at the
   same height executes: the one-block conservatism), "one block early is refused by the script, and the builder
   will not build it", "a leg that takes more than the slice is refused", "a fill below tolerance is refused: one
   token shaved from the owner's output", "with a tolerance, the same shave is accepted", "an executor fee above the
   cap is refused", "the absolute cap refuses a dear pool and accepts a cheap one", "two clocked boxes in one
   transaction are refused", "a backdated successor is refused: legs cannot come faster than the interval". Sell:
   "one block early is refused by the script, and the builder will not build it", "a leg that sells more than the
   slice is refused", "a fill below tolerance is refused: one nanoERG shaved from the owner's output", "with a
   tolerance, the same shave is accepted", "an executor fee above the cap is refused", "the floor refuses a cheap
   pool and accepts a dear one", "two sell boxes in one transaction are refused", "a backdated successor is refused:
   legs cannot come faster than the interval". Cost: "prints the evaluation cost of one leg" (332 buy, 340 sell,
   skunkyard SK-064).
6. The clock is the box's creation height, set by the builder to `h + 1`; a leg or a create that waits in the
   mempool for `w` blocks still carries `h + 1`, so its first interval is short by `w` (README "Units and limits").
   An executor may shorten one interval by at most `SLACK` (4) blocks by backdating within the bound, and a built
   leg expires `SLACK` blocks after `h` for the same reason. The explorer's height lags the node's by up to a block
   or more; with the builder's one-block margin above, a lagging explorer costs a leg one more block, never
   validity. A storage-rent claim recreates the box at the claim height and restarts the clock (`Clock.es` header,
   "F1"). One pool per transaction: `INPUTS(0)` must carry the pinned NFT and the pool's own script binds
   `OUTPUTS(0)`; the leg cannot be routed through another pool or share a transaction with a second leg.

## `buildCancelClock` (`clock.ts:401`; the owner's key)

1. `only the owner can cancel`, `the box no longer covers a miner fee` (`value <= FEE`).
2. User: nothing but the click (`src/ui/programs.ts`). Chain: the box. The box itself pays the fee; no other
   input, so no wallet box is spent.
3. One output: `value - FEE` to the owner with `R4 = the box id`, every token of the box copied.
4. The script's owner path is `owner || sigmaProp(leg)` (`Clock.es:107`): any transaction the owner signs is valid,
   so nothing is refused beyond the signature; a stranger's cancel fails on the signature, and the keyless leg path
   fails without context variable 0.
5. "the owner cancels at any time, everything back less the miner fee", "a stranger cannot cancel" (both sides;
   the sell case is "the owner cancels at any time, the tokens and the ERG back less the miner fee").
6. The `value <= FEE` guard means a buy box drained to a last leg smaller than the fee cannot be cancelled by this
   builder; the owner's key can still spend it from any wallet with another input.

Properties: `test/properties/clock.test.ts` (a leg sized by `sizeLeg` is accepted by the script at its due height
and refused one block early, over random pools and programs).
