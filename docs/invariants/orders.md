# Orders: Machina limit orders and EIP-31 Babel bids

Modules: `src/protocols/machina/orders.ts` (create, fill, close, describe, capacity) and
`src/protocols/babel/babel.ts` (describe, capacity, the taker's fill; the keyless take `sizeBabelTake` and
`buildBabelTake` are in `upkeep.md`). Registry: `machina-e2t-limit-order` (`03ef002b73a8`), `eip31-babel`
(`4e83fa68ef3e`). Tests: `src/protocols/machina/orders.test.ts`, `src/protocols/babel/babel-fill.test.ts`;
`test/sizing.test.ts` for the takes.

## Machina E2T limit orders

The contract is the SDK's `CONTRACTS.E2T` proposition (`@nautls/machinafi-sdk` 0.1.0,
`node_modules/@nautls/machinafi-sdk/dist/index.mjs:261`), the quote token id a constant replaced at build time; its
ErgoScript source is not in the package or the repository's npm tarball, so the contract's own rules are stated
here from the SDK's builders and from what the mock chain accepts and refuses [UNVERIFIED beyond those tests].
Registers (`index.mjs:309-315`): R4 the owner's SigmaProp, R5 the price as `SLong` in nanoERG per smallest token
unit, R6 `SBool`, `true` for an order takers buy tokens from, `false` for one takers sell tokens into. The page
names orders by the taker's action, as the SDK and the contract do (`orders.ts:19-25`).

### `buildCreate`

1. Throws `tokenAmount must be a positive amount` / `ergAmount must be a positive amount` (`orders.ts:156`) for
   the side's missing or non-positive amount; the SDK throws `Quote token price must be greater than zero`,
   `Quote asset cannot be ERG`, `Base and quote assets must be different`, `Asset amounts cannot be negative`
   (`index.mjs:399-404`).
2. The user sets the side, the token id, the amount and the price in ERG per whole token, which
   `ergPerTokenToPrice` turns into nanoERG per unit and refuses when it would round (`units.ts:30-39`, message
   `price must be a multiple of ... ERG per token`); the page's call site is `src/ui/orders.ts`. Nothing is read
   from the chain for a create.
3. No arithmetic beyond the SDK's box: selling tokens makes an R6-true box holding the tokens at the minimum value
   for its bytes (`estimateMinBoxValue()`, `index.mjs:412`); buying tokens makes an R6-false box holding the ERG
   budget and no tokens.
4. Whatever the contract requires of a fresh order is the SDK's shape; the contract is not evaluated on creation
   (the inputs are the owner's own boxes).
5. `orders.test.ts` "owner sells tokens: create, partial fill, full fill" and "owner buys tokens: create, taker
   sells into it, owner closes the rest" (the created box describes as expected and is then spendable).
6. The price is an integer per smallest unit, so a token with many decimals cannot be priced below one nanoERG per
   unit (README "Units and limits").

### `buildFill`

1. The SDK throws `Amount must be greater than zero`, `Amount exceeds the available quote tokens` (taker buys more
   than the box holds), `Insufficient base amount to cover the payout` (taker sells more than the box's ERG pays
   for), `Buy action is not allowed in this contract` / `Sell action is not allowed` (the side read from R6
   disagrees), and on a sell that leaves the order with less than its minimum box value
   `Remaining base amount is not enough to cover the minimum box value of ... nanoergs` (`index.mjs:328-331`,
   `:358-361`, `:378`). `asOrderBox` throws `box ... lacks R4-R6` (`orders.ts:15`).
2. The user types the token amount (default: the listing's capacity, `src/ui/orders.ts`); the price, the
   side and the box come from the chain (the listing, cached up to 30 s; not re-read before the build).
3. Taker buys `n` tokens: the order's successor holds `value + n * price` and `tokens - n`; a full buy pays
   `value + n * price` to the owner instead (`index.mjs:334-353`). Taker sells `n`: the successor holds
   `value - n * price` and `tokens + n`; when the remainder is at most `SAFE_MIN_BOX_VALUE` (0.001 ERG) or below
   one unit's price, the SDK closes the order to the owner with the remainder and the tokens (`index.mjs:364-388`).
   Exact products, no rounding. The partial successor carries R7 = the spent box id, the owner's payout R4 = the
   box id (`index.mjs:342-351`, `:376-387`); context variable 0 names the output (`:390`).
4. The contract's price check (the test below shows one nanoERG short refused) and its bound of the output to the
   spent box; the exact clauses are [UNVERIFIED] (no source).
5. `orders.test.ts` "an underpaying fill is refused by the contract" (one token's price shaved from the recreated
   order); "owner sells tokens: create, partial fill, full fill" (the partial and the closing fill); "owner buys
   tokens: create, taker sells into it, owner closes the rest".
6. `capacity` for an order takers sell into is `floor(value / price)` (`orders.ts:152`); selling exactly that
   many leaves a remainder below one price, which the SDK closes to the owner, and if that remainder is below the
   owner output's minimum box value the SDK refuses the build. The listing's default amount can therefore be
   refused by the builder for a nearly empty order; the taker types a smaller amount. The keyless take leaves
   0.0001 ERG for this reason (`machina-arb.ts:27-30`).

### `buildClose`

1. `asOrderBox` throws `box ... lacks R4-R6`; nothing else: the owner's boxes are added so the fee can be paid when
   the order box cannot (`orders.ts:95-108`).
2. The user picks their own order (the page shows "close" only on rows whose R4 is the wallet's, `src/ui/orders.ts`).
3. None: the order box is spent as an input without a context variable (`order.close()`, `index.mjs:394-395`), change
   to the owner.
4. The contract refuses a close not signed by R4.
5. `orders.test.ts` "a taker cannot close someone else's order"; "owner buys tokens: create, taker sells into it,
   owner closes the rest".
6. None.

### `describe` and `capacity`

1. `asOrderBox` throws `box ... lacks R4-R6`; `takerAction` throws `order box has no R6`; the SDK throws
   `Invalid Limit Order contract`, `Invalid quote token for the contract`, `Invalid price register`,
   `Invalid order type register` (`index.mjs:272-315`); a box the explorer lists under the template hash that any of
   these rejects is skipped by the page (`listings`, `src/ui/orders.ts`).
2. All from the box.
3. `capacity`: `tokenAmount` for a taker-buy order, `floor(value / price)` for a taker-sell order.
4. n/a.
5. `orders.test.ts` asserts `capacity` of 100 on both sides.
6. See `buildFill` 6.

## EIP-31 Babel bids

The contract is EIP-31's (`ergoplatform/eips`, `eip-0031.md` at `81edece`, fetched 2026-10-29); the registry
template is the EIP's compiled hex with `{tokenId}` at hex offset 12. Registers: R4 the creator's SigmaProp, R5
`ergPricePerToken` as a Long; R6 of a recreated box is the spent box id. The contract's two rules for a swap,
quoted:

```
(recreatedBabelBox.propositionBytes == SELF.propositionBytes),
(recreatedBabelBox.tokens(0)._1 == tokenId),
(recreatedBabelBox.R4[SigmaProp].get == babelFeeBoxCreator),
(recreatedBabelBox.R5[Long].get == ergPricePerToken),
(recreatedBabelBox.R6[Coll[Byte]].get == SELF.id)
...
(babelTokensDifference * ergPricePerToken >= nanoErgsDifference),
(nanoErgsDifference >= 0)
```

where `nanoErgsDifference = SELF.value - recreatedBabelBox.value` and `babelTokensDifference` is the recreated
box's first-token amount less the spent box's (0 when it held none). Without context variable 0 the box is the
creator's to spend.

### `describeBabel` and `babelCapacity`

1. Throws `not an EIP-31 Babel box` (the tree is not the template filled with its own offset-12 token id), `Babel
box lacks R4 or R5`, `Babel box holds the wrong token` (`babel.ts:35-40`).
2. All from the box.
3. `babelCapacity = floor((value - BABEL_KEEP) / bid)` with `BABEL_KEEP = 0.001 ERG` (`babel.ts:52`, `:143-146`),
   0 when the bid is 0 or the box is at the keep.
4. The contract has no keep: it allows the recreated box down to the node's minimum value for its bytes. The keep
   is this page's convention (the README: "the mainnet takes left 0.001") so the recreated box is always valid.
5. `babel-fill.test.ts` "pays the taker the bid for the tokens and recreates the box with them" asserts 33,300 for a
   1 ERG box at 30,000.
6. A box whose first token is not the contract's token (possible: the contract checks `tokens(0)._1` only on the
   output) throws at `:40` and is skipped.

### `buildFillBabel`

1. Throws `tokenAmount must be a positive amount`, `the Babel box pays for at most ${cap} units` (`babel.ts:164-166`).
2. The user types the amount (default the capacity, `src/ui/orders.ts`); bid, value and tokens from the
   listing (cached up to 30 s, not re-read).
3. `erg = tokenAmount * bid` exactly (`:167`); the recreated box at output 0 holds `value - erg` and
   `tokens + tokenAmount`, R4 and R5 copied, R6 = the spent box id; context variable 0 = `SInt(0)` names it
   (`:175`). Equality is the contract's bound (`babelTokensDifference * ergPricePerToken >= nanoErgsDifference`), so
   the taker is paid exactly the bid; the ERG lands in the taker's change.
4. The contract also refuses a recreated box with a changed script, token, R4 or R5, or a wrong R6; the builder
   copies them and does not re-check.
5. `babel-fill.test.ts` "one nanoERG more for the taker is refused by the script"; "refuses more than the box pays
   for, and nothing at all" (builder).
6. The Babel input needs no signature; the taker's inputs do. Another taker's fill mined first spends the box and
   this transaction is simply invalid.

Properties: none of the Machina or Babel fill builders has a property test; `test/sizing.test.ts` (brute-force
optimum of the keyless takes) covers the sizing side, see `upkeep.md`.
