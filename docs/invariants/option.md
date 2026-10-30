# The option as a timed escrow: invariants

Modules: `src/protocols/option/option.ts` against `contracts/Call.es` and `contracts/Put.es`; registry entries
`option-call` (`da26dcb30f5b…`, 373 bytes) and `option-put` (`1296e3affd09…`, 357 bytes); tests
`src/protocols/option/option.test.ts` (cases "1." to "14." run once per side), `test/hashes.test.ts` (recompiles
both sources), `test/upkeep-option.test.ts`, `test/properties/option.test.ts`; the page's call site
`src/ui/options.ts`; the writer's reclaim from the upkeep timer `src/ui/upkeep.ts` via `expiredOptionsFor`
(`src/upkeep.ts`).

Registers (both contracts): R4 the writer (SigmaProp), R5 the token id, R6 `(amount, strike, expiry, premium)` as
`Coll[Long]`, R7 the buyer once sold. Constants shared with the clocked box (`clock/clock.ts`): `OWNER_BOX_VALUE`
100,000 nanoERG, `RENT_PERIOD` 1,051,200, `STORAGE_FEE_FACTOR` 1,250,000 per byte, `MIN_VALUE_PER_BYTE` 360;
`LONG_MAX` 2^63 - 1 (`option.ts:42`). The mock chain evaluates at `HEIGHT = chain.height + 1` (`option.test.ts:3-6`);
"at height" below is the build height `h`.

The script's clock is `open = HEIGHT.toLong <= expiry` (`Call.es:36`, `Put.es:32`): the expiry is the last block
in which a buy or an exercise can land. The writer's path is `writer && sigmaProp(!sold || !open)`
(`Call.es:75`, `Put.es:71`).

## `describeOption` (`option.ts:73`)

1. `not an option box`, `option box lacks a register` (R4 to R6), `option box R6 must hold four terms`, `call box
does not hold its token first`.
2. Everything from the box; `sold = R7 present`, `strikeTotal = strike x amount`, `expiry` as a number.
3. No arithmetic beyond `strikeTotal`.
4. A describer. A malformed box under either tree is skipped by the listings and the upkeep
   (`src/ui/options.ts`, `src/upkeep.ts` `expiredOptionsFor`).
5. The `write` helper's assertions on every case (`option.test.ts:79-104`).
6. None.

## `sizeWrite` and `buildWrite` (`option.ts:132`, `176`; the writer's key)

1. `amount must be positive`, `strike must be positive`, `premium must be at least 100000 nanoERG, the smallest box
that can carry it`, `expiry must be a height after now` (`expiry <= height`), `expiry must be within one
storage-rent period (1051200 blocks) of now`, `strike x amount does not fit a Long` (`strike > LONG_MAX /
amount`); put: `the collateral (N nanoERG) is below the node's minimum for a B-byte box`, `strike x amount does
not fit a Long` (`strikeTotal > LONG_MAX - FEE`); call: `strike x amount plus the box's value does not fit a
Long` (`strikeTotal > LONG_MAX / 2`). `sigmaOf` throws `the address must be a P2PK address`.
2. User: side, token, amount, strike (`ergPerTokenToPrice`, `src/units.ts`: an integer in nanoERG per smallest
   unit or `price must be a multiple of … ERG per token`), expiry as blocks from now, premium
   (`src/ui/options.ts`). Chain: the height. The quote uses the height from the last listing
   (`options.ts:191`); the build re-reads the wallet's height and recomputes the terms (`readForm(hh)`,
   `options.ts:242`). Without a wallet the quote sizes the box with the curve's generator as the writer
   (`GENERATOR`, `options.ts:30`, 76); never an output. The form refuses `blocks > RENT_PERIOD` before the build
   (`options.ts:238`).
3. Put: `value = strikeTotal`, the collateral and nothing more; `bytes` estimated at that value. Call: `value =
rentReserve = bytes x STORAGE_FEE_FACTOR`, iterated at most four times to a fixed point because the value's
   encoding changes `bytes` (`option.ts:161-166`); the box is sized as sold (R7 = the writer, since any P2PK buyer
   takes the same bytes, `option.ts:142`). The reserve exceeds the node's minimum by construction (1,250,000 >
   360 per byte). `expiry` is absolute; `strike` and `amount` are Longs in R6. R7 absent.
4. The contract runs no check at creation (an output of the writer's key spend). What it will refuse later that
   the sizing does not catch: nothing found; the Long guards cover `pay.value >= SELF.value + strike * amount`
   (`Call.es:66`).
5. "1. write: the box holds the underlying and the terms, R7 absent; the builder refuses an expiry past a rent
   period" (also the `after now`, `premium`, `amount` and the put's `minimum` refusals; prints the bytes and the
   reserve: a sold call box of 569 bytes holds 0.71125 ERG, skunkyard SK-065).
6. The rent reserve rule for token-holding boxes: a call box holds tokens, so a box that cannot pay its rent after
   one period is consumed whole; the reserve is one fee for its bytes, returned on exercise or reclaim. A put holds
   ERG only and none; a rent claim on an abandoned put takes one fee from the collateral and recreates it. The
   expiry must be within one rent period so a sold box is never claimed before the buyer's right ends.

## `canBuy`, `canExercise`, `canReclaim` (`option.ts:192-197`)

`canBuy = !sold && height < expiry`; `canExercise = sold && height < expiry && (buyer matches)`; `canReclaim =
!sold || height >= expiry`. With `HEIGHT = h + 1` these coincide with the script's `open` exactly: at `h = expiry -
1` the script sees `HEIGHT = expiry`, open; at `h = expiry` it sees `expiry + 1`, closed. The header of
`option.test.ts` (line 5) says the builders "refuse one block earlier than the script does"; the cases do not show
that: "4b. exercise at the expiry itself is accepted (the last valid block)" builds unforced at `h = expiry - 1`
and "5. exercise at expiry + 1 is refused" needs no force to fail the script at `h = expiry`. The guards are exact,
not early; the forced builds in the cases exist to show the script refusing on its own.

## `buildBuy` (`option.ts:209`; keyless)

1. `this option is already sold`, `this option has expired or expires in the next block` (`height >= expiry`).
2. User: the click (`src/ui/options.ts`, shown only when `canBuy`). Chain: the box, the buyer's own boxes for
   the premium and the fee. The buyer is the connected wallet's change address.
3. Output 0: `premium` to the writer with `R4 = the box id`; output 1: the successor with `value`, the tokens and
   R4 to R6 copied and `R7 = the buyer`; context variables 0 = 0 and 1 = 1 (`option.ts:223`). The script: `open`,
   `onlyOne`, `pay.propositionBytes == writer.propBytes`, `pay.value >= premium`, `pay.R4 == SELF.id`,
   `next.value >= SELF.value`, `next.tokens == SELF.tokens`, `next.R4..R6` equal, `next.R7[SigmaProp].isDefined`
   (`Call.es:40-56`, `Put.es:36-52`). The buyer's boxes are selected to cover `premium + FEE` plus the successor's
   value is funded by the box itself.
4. Not pre-checked: a premium short by one (`pay.value`), a second option box in the transaction (`onlyOne`,
   `Call.es:38`), a successor with the wrong tokens or value, a buy at `h = expiry` (forced). The script accepts
   any R7 (`isDefined`), so a transaction by another builder may name any buyer; this builder names the signer.
5. "2. buy by a stranger is accepted: the premium to the writer, the stranger in R7, the box's value and tokens
   unchanged", "3. a second buy of a sold box is refused", "11. premium one nanoERG short is refused", "12. two
   option boxes in one transaction are refused", "13. (added) a buy at the expiry is accepted; at expiry + 1 the
   builder refuses and, forced, so does the script".
6. The buyer's right is the address in R7, not a token: it cannot be resold. The premium floor is
   `OWNER_BOX_VALUE` because output 0 must be a box.

## `buildExercise` (`option.ts:246`; the buyer's key)

1. `this option is unsold`, `only the named buyer can exercise`, `this option has expired or expires in the next
block`.
2. User: the click (`options.ts:170`, shown only when `canExercise` for the connected address). Chain: the box;
   the buyer's boxes pay the strike (call) or deliver the tokens (put), plus `OWNER_BOX_VALUE` and the fee.
3. Call: output 0 `value + strikeTotal` to the writer, output 1 `OWNER_BOX_VALUE` with `amount` of the token to
   the buyer, both with `R4 = the box id`; the script's `pay.value >= SELF.value + strike * amount`,
   `get.tokens(0)._1 == tokenId`, `get.tokens(0)._2 >= amount` (`Call.es:66-70`). Put: output 0 `OWNER_BOX_VALUE`
   with `amount` of the token to the writer, output 1 `value` to the buyer; `pay.tokens(0)._2 >= amount`,
   `get.value >= SELF.value` (`Put.es:62-66`). `strike x amount` is computed in the Long domain on both sides; the
   write-time guards keep `SELF.value + strike * amount` under `LONG_MAX`. Context variables 0 = 0, 1 = 1. The
   exercise path is `buyer.get && sigmaProp(...)` (`Call.es:62`): the buyer's signature is required.
4. Not pre-checked: paying one nanoERG less than the strike (call) or delivering one unit less (put), a non-buyer's
   signature (the builder checks the name; a forged transaction fails the proof), `onlyOne`, the exercise at `h =
expiry` (forced), the `R4` bindings.
5. "4. exercise by the buyer before the expiry is accepted: the strike to the writer, the underlying across",
   "4b. exercise at the expiry itself is accepted (the last valid block)", "5. exercise at expiry + 1 is refused",
   "6. exercise by a non-buyer is refused", "7. exercise paying one nanoERG less than the strike is refused" (call)
   and "7. exercise delivering one unit less than the amount is refused" (put), "14. (added) prints the evaluation
   cost of the buy and the exercise" (201 and 177 for the call, 194 and 169 for the put, SK-065).
6. No partial exercise: `amount` whole or nothing. The explorer's height lags the node: an exercise built at the
   explorer's `h = expiry - 1` when the node is already at `expiry` is checked at `expiry + 1` and refused; the
   builder cannot know, so the last block is not reliable from the page.

## `buildReclaim` and `buildCancelUnsold` (`option.ts:283`, `301`; the writer's key)

1. `only the writer can reclaim`, `this option is sold and open until height N` (`!canReclaim`);
   `buildCancelUnsold` adds `this option is sold; it can be reclaimed after its expiry` and then calls
   `buildReclaim`.
2. User: the click (`options.ts:174`, labelled "reclaim" once `expiry <= height`, "cancel" before) or the upkeep
   timer, once per box, for the writer's expired options (`src/ui/upkeep.ts`, `expiredOptionsFor` with `height >=
expiry`). Chain: the box; the writer's boxes pay the fee.
3. One output: `value` with every token of the box to the writer, `R4 = the box id`. The script's writer path
   `writer && sigmaProp(!sold || !open)` (`Call.es:75`): any transaction the writer signs while unsold or once
   `HEIGHT > expiry`.
4. Not pre-checked: nothing but the signature and the clock; a sold box before the expiry is refused by the script
   (the builder refuses first), a stranger's reclaim fails the proof.
5. "8. writer reclaim at the expiry is refused and at expiry + 1 accepted", "9. writer cancel while unsold is
   accepted", "9b. a stranger cannot cancel an unsold option", "10. writer cancel after the sale, before the
   expiry, is refused"; the upkeep's selection "picks the expired options the visitor wrote, sold or not, and
   leaves the others" (`test/upkeep-option.test.ts`).
6. An unsold option that has not expired is left alone by the upkeep: cancelling it is a choice (`src/upkeep.ts`
   `expiredOptionsFor` comment). The strike is an integer in nanoERG per smallest unit, as a limit order's price
   is; a strike in a token (a SigUSD-denominated put) is not built (README).

Properties: `test/properties/option.test.ts` (exercise and reclaim accepted and refused on each side of the
expiry, over random terms).
