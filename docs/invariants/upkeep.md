# Upkeep: invariants (the keyless jobs and the two wallet-signed ones)

Modules `src/upkeep.ts` (jobs, `keylessJson`, `runUpkeep`), `src/protocols/babel/babel.ts` (`sizeBabelTake`,
`buildBabelTake`), `src/protocols/machina/machina-arb.ts` (`sizeOrderTake`, `buildOrderTake`),
`src/protocols/clock/clock.ts` (`buildLeg`, in `clock.md`), `src/ui/upkeep.ts` (the timer), `scripts/upkeep-run.ts`
(the Node runner). Registry entries `ergodex-n2t-pool` (`2dcc7830afe8`), `eip31-babel` (`4e83fa68ef3e`),
`machina-e2t-limit-order` (`03ef002b73a8`), `clock-buy` (`a1df056602fa`), `clock-sell` (`7bf4e2d6ba91`),
`sigmafi-bond-erg` and `-token`, `option-call` and `-put`. Tests `src/protocols/babel/babel.test.ts`,
`src/protocols/machina/machina-arb.test.ts`, `test/sizing.test.ts`, `test/keyless.test.ts`,
`test/upkeep-lender.test.ts`, `test/upkeep-option.test.ts`, `test/ui/upkeep.test.ts`, `test/ui/phone.test.ts`.

What every keyless job shares: no input is the visitor's, no signature is produced, the pool successor is
`OUTPUTS(0)` (the pool script's own rule: `val successor = OUTPUTS(0)`, `Pool.sc:10`), the bounty is an output to
the visitor's change address, and the miner fee comes out of the gap. The visitor's wallet is never asked.

## `sizeBabelTake` and `buildBabelTake` (a Babel bid above its pool)

1. `sizeBabelTake` throws `the pool's token is not the Babel box's token` (`babel.ts:74`); returns `undefined` when
   the box has no ERG above `BABEL_KEEP` (0.001 ERG, `:52`), the bid is zero, or no `t` pays after the fee
   (`:76-105`). `buildBabelTake` returns `undefined` when sizing does (`:116`). `describeBabel` throws `not an EIP-31
Babel box`, `Babel box lacks R4 or R5`, `Babel box holds the wrong token` (`:35-40`).
2. Chain: the pool (x, y, feeNum) and the Babel box (R5 bid, value, tokens held, R4 owner). User: nothing; `payTo` is
   the wallet's change address.
3. Pool leg, for `t` tokens out of the pool: `dx = ceil(t * x * 1000 / (feeNum * (y - t)))` (`:77`, `cost`). This is
   `validSwap` with `deltaReservesX > 0` solved for the smallest integer `dx`:
   `reservesY0.toBigInt * deltaReservesX * feeNum0 >= -deltaReservesY * (reservesX0.toBigInt * FeeDenom +
deltaReservesX * feeNum0)` (`Pool.sc:58`), with `-deltaReservesY = t`. Babel leg: `y = min(t * bid, value -
BABEL_KEEP)` (`:78`, `:97`), the EIP-31 exchange check `babelTokensDifference * ergPricePerToken >=
nanoErgsDifference` and `nanoErgsDifference >= 0`. Profit `y - dx` is maximised by a ternary search on `t` over
   `[1, min(ceil(cap / bid), y - 1)]`, then a scan of the four neighbours each side (`:80-96`); payout = `y - dx - fee`
   (`:99`). The claim that profit is concave in `t` (`:70`) holds because `dx(t)` is convex (its denominator falls
   linearly) and `min(t * bid, cap)` is concave; the brute-force comparison below is the check, not the argument.
   Outputs (`:113-139`): 0 the pool successor (`x + dx`, `y - t`, R4 copied), 1 the Babel box recreated under its own
   tree with `tokens + t`, `value - y`, R4 and R5 copied, R6 = the spent box id, 2 the payout. Context variable 0 of
   the Babel input is `SInt(1)`, the index of its successor (`:132`; EIP-31 `getVar[Int](0)`).
4. The pool checks every reserve and token rule itself; the Babel script checks the recreation (`propositionBytes`,
   `tokens(0)._1 == tokenId`, R4, R5, R6 = `SELF.id`) and the exchange inequality. The builder does not pre-check that
   `t < y` beyond the search bounds, nor the pool's `validStorageRent` (the successor only gains ERG).
5. `babel.test.ts`: "takes the gap with no signature and pays the builder" (`signers: []`, `y == dx + payout + fee`),
   "finds nothing to take when the bid is below the pool", "one nanoERG more for the taker is refused by the Babel
   script". `test/sizing.test.ts`, "Babel": the payout equals the brute-force maximum over all `t` on three pools.
6. `BABEL_KEEP` is a page rule, not the script's: EIP-31 lets the box go to any non-negative value; the node's
   minimum value per byte is what would refuse an emptier box.

## `sizeOrderTake` and `buildOrderTake` (a Machina order priced across its pool)

1. `sizeOrderTake` throws `the pool's token is not the order's token` (`machina-arb.ts:27`); returns `undefined` when
   the order can take less than one unit or its price is zero (`:31`), or no `t` pays after the fee (`:50-51`).
   `buildOrderTake` returns `undefined` when sizing does (`:69`). `describeOrder` (`orders.ts`) throws `box … lacks
R4-R6` and `order box has no R6`.
2. Chain: the pool and the order box (R5 price, R6 side, its ERG or tokens). User: nothing.
3. Into an order that buys tokens (taker action "sell"): buy `t` from the pool for `ceilDiv(t * x * 1000, feeNum *
(y - t))` (`:33`, the same `validSwap` line as above) and sell them to the order for `t * price` (the SDK's
   `sell`: `basePayout = amount * this.#price.sell`, `machinafi-sdk/dist/index.mjs:200`). Cap: `t <= (value -
100_000) / price` and `t < y` (`:31`). Out of an order that sells tokens (taker action "buy"): pay `t * price`
   to the order and sell `t` to the pool for `quote(pool, "token-to-erg", t) = floor(x * t * feeNum / (y * 1000 + t *
feeNum))` (`:33`, `amm.ts quote`; `Pool.sc:60`). Cap: the order's token amount. Ternary search then a scan, as for
   Babel (`:36-48`); payout = profit minus the fee (`:51`). Outputs (`:71-88`): 0 the pool successor, then the SDK's
   order output bound by index through its context variables (`SBool`, `SInt(outputsLength - 1)`,
   `index.mjs:184-186`), then the payout.
4. The pool and the order scripts check the amounts; the builder does not pre-check the order's own rules beyond the
   SDK's two throws (`Amount must be greater than zero`, `Amount exceeds the available quote tokens` or `Insufficient
base amount to cover the payout`, `index.mjs:166-167`, `:197-198`).
5. `machina-arb.test.ts`: "an order buying tokens above the pool is taken: pool to order, gap to the builder", "an
   order selling tokens below the pool is taken: order to pool, gap to the builder" (the whole 10,000-unit order,
   fully filled), "nothing to take when the order sits inside the pool price". `test/sizing.test.ts`, "Machina, both
   sides". No case shaves the order output; the order script's refusal of an underpaid fill is
   `src/protocols/machina/orders.test.ts`, "an underpaying fill is refused by the contract".
6. The comment at `machina-arb.ts:28-29` says the 0.0001 ERG left in an order is "which the SDK checks": the SDK
   checks only that the payout fits the order's ERG (`index.mjs:198`); the box minimum is Fleet's build-time check
   on every output. The margin is a page rule that keeps a partial recreation or a full-fill payout above the
   node's minimum value per byte.

## `clockLegs` (the legs of clocked boxes that are due)

Covered in `clock.md`: `buildLeg` declines a leg that is not due at the explorer's height (`clock.ts`,
`due = height - creationHeight >= interval`), whose price is outside the bound, or whose fee does not cover the
miner fee and the owner's output. The job lists both templates, skips a box whose `dueAt` is above the height, and reads the program's
own pool by NFT (`upkeep.ts:114-151`).

## `babelVsPool`, `ordersVsPool` (the finders)

- The deepest ERG pool per token id is chosen from the explorer's listing of up to 500 pools (`upkeep.ts:23-31`);
  500 Babel boxes and 200 orders are read (`:51`, `:79`). A box the describer rejects is skipped (`:55-59`,
  `:83-87`); an order whose take throws is skipped (`:93-96`). Candidates are sorted by bounty, largest first.
- Each finder builds against the pool listing the explorer served, cached for `CACHE_MS` (30 s, `explorer.ts`); a
  pool that moved since is refused by the pool script at submission, which is a log line, not a loss.

## `maturedBondsFor`, `expiredOptionsFor` (the two jobs that need the wallet)

- Not in `JOBS`: the liquidation and the reclaim are keyless or the writer's key path respectively, but the miner fee
  must come from the visitor's own boxes, so `send` is used and the wallet is asked once per box (`src/ui/upkeep.ts`,
  the `asked` set). `maturedBondsFor` returns bonds whose R8 is one of the wallet's addresses, `maturity <= height`,
  and whose collateral is more than the fee (`upkeep.ts:160-186`); `expiredOptionsFor` returns options whose writer
  is the wallet and `expiry <= height`, sold or not (`:190-212`). With no addresses neither calls the explorer.
- Proof: `test/upkeep-lender.test.ts`, "picks the matured bond lent by the visitor and leaves the others";
  `test/upkeep-option.test.ts`, "picks the expired options the visitor wrote, sold or not, and leaves the others";
  `test/ui/upkeep.test.ts`, "asks the wallet to sign the collateral hand-over of the matured bond, once" and "does
  nothing when the checkbox is off"; `test/ui/phone.test.ts`, "asks the phone for the matured bond's hand-over from
  the upkeep timer".

## `keylessJson` (the node JSON of a transaction with no proofs)

- The id is `blake2b256` of Fleet's serialisation of the transaction with every input's proof empty and its
  extension kept (`upkeep.ts:215-227`); it equals the id Fleet assigns because a transaction's id is defined over
  the unsigned bytes (proofs are not in the id). The JSON writes values and amounts as raw integers through
  `JSON.rawJSON` so a 2^63-scale amount survives, and throws `integer … too large for this browser's JSON` where
  `rawJSON` is missing and the number is unsafe (`:229-234`).
- Proof: `test/keyless.test.ts`, "serializes to the same id as Fleet and leaves every proof empty" (the
  9,223,372,036,854,775,000 amount appears verbatim).

## `runUpkeep` (one round)

- Height from the explorer; every job's candidates submitted in turn through the explorer's mempool endpoint; a
  candidate sharing an input with one already submitted this round, or with one in `recent`, is skipped
  (`upkeep.ts:258-299`). `recent` maps box id to the time it was spent and is forgotten after `RECENT_MS` (10
  minutes, `:251`); the page keeps it across ticks (`src/ui/upkeep.ts`, `recent`) and the Node runner across rounds
  (`scripts/upkeep-run.ts`, `recent`). The timer runs every `UPKEEP_EVERY_MS` (3 minutes, `src/ui/upkeep.ts`)
  while the checkbox is on and a wallet is connected, and never overlaps itself (`busy`).
- A submission the explorer refuses is logged as `not submitted (…)` and the inputs are not marked spent.

## Limits

- The explorer lists a spent box as unspent until the block that spends it; `RECENT_MS` covers a mempool wait of ten
  minutes, after which a box still listed is tried again (and refused by the node as already spent, a log line).
- One pool per transaction: the pool successor must be `OUTPUTS(0)`, so no job combines two takes against one pool
  in one transaction; two candidates on the same pool box are serialised by the shared-input rule above.
- The explorer's height lags the node's; a leg or a liquidation judged due at the explorer's height is validated
  by the node at a height at least one higher, which only makes it more due. A reduction for the phone path is the
  exception (`signing.md`).
- A keyless transaction is anyone's to front-run; the bounty goes to whoever's transaction the miner takes.

Properties: `test/properties/sizing.test.ts` (the Babel and Machina sizing never pay below the brute-force maximum on
pools small enough to enumerate).
