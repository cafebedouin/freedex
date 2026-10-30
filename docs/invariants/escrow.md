# Escrow: invariants (TokenJay)

Module `src/protocols/tokenjay/escrow.ts`; registry entry `tokenjay-escrow` (`b2c3338d244f`); tests
`src/protocols/tokenjay/escrow.test.ts`, `test/ui/positions.test.ts`.

The script is published at https://tokenjay.app/escrow.html (fetched 2026-10-29; quoted below) with no stated
licence; the page builds against the deployed tree only. Registers, from the script's own comment: R4 the seller's
tree, R5 the price in nanoERG, R6 the "UI fee" per thousand, R7 the fee tree, R8 the buyer's tree; the box's first
token is the sale.

## `describeEscrow` (reading a box)

1. Throws `not a TokenJay escrow box` when the tree differs (`escrow.ts:35`), `escrow box lacks a register` (R4 to
   R8, `:37`), `escrow box holds no token` (`:38`).
2. Everything from the chain: seller and buyer as addresses of the trees in R4 and R8, `price` R5, `feeRate` R6,
   `feeTree` R7, the first token and amount, the box value.
3. None.
4. Nothing; it does not build.
5. `test/ui/positions.test.ts` renders the listing.
6. A box holding more than one token is described by its first token only; the script sells `SELF.tokens(0)` and says
   nothing about the rest ("only a single token and ERG value is secured by this script").

## `escrowFee`

- `max(price * feeRate / 1000, 1,000,000)` with floor division (`:52-55`), the script's
  `val feeAmount = max((ergAmountToPay * uiFeePerThousand) / 1000, 1000000)`. The page writes `feeRate = 0`, so the
  fee is always 0.001 ERG and goes to the seller.

## `buildCreateEscrow` (the seller offers)

1. Throws nothing of its own; `ErgoAddress.fromBase58` on the page throws on a bad buyer address
   (`src/ui/escrow.ts`, the `create-escrow` submit), and Fleet throws when the seller lacks the tokens.
2. User: buyer address, token id, amount, price (`src/ui/escrow.ts`). Chain: nothing. The builder sets R6 = 0 and
   R7 = the seller's own tree (`:73-74`), the box value 0.001 ERG (`:70`).
3. Registers as `SColl(SByte, tree)` and `SLong`; no arithmetic.
4. The script is not evaluated at creation.
5. The `create()` helper of every case in `escrow.test.ts` checks `seller`, `buyer`, `price` and `feeRate === 0n`.
6. The 0.001 ERG the seller puts in becomes the buyer's token box (see `buildTakeEscrow`).

## `buildTakeEscrow` (the named buyer pays)

1. Throws `only the named buyer can take this escrow` when the wallet's address differs from R8 (`:98`).
2. Chain: the escrow box (price, fee rate, fee tree, seller tree, token). User: nothing but the click.
3. Outputs in the script's order (`:100-108`): 0 the pay box, `price - fee` to R4's tree with R4 = the escrow id; 1
   the token box, 0.001 ERG plus the token to the buyer; 2 the fee box, `fee` to R7's tree. The script:
   `payBox.propositionBytes == seller && payBox.value >= ergAmountToPay - feeAmount && feeBox.propositionBytes ==
uiFeeAddress && feeBox.value >= feeAmount && payBox.R4[Coll[Byte]].get == SELF.id && buyBox.tokens(0) ==
tokenToSell && buyBox.propositionBytes == buyer`. The buyer pays the price exactly: the escrow's own 0.001 ERG
   funds the token box and the miner fee comes from the buyer's change (`escrow.test.ts`, "the named buyer takes it;
   the contract's fee returns to the seller": buyer down by 2 ERG exactly, seller up by 2 ERG exactly).
4. The script does not check who signs the spend; "the named buyer" is enforced by `buyBox.propositionBytes ==
buyer`, so a stranger paying the price would deliver the tokens to the buyer, not to themselves. The builder's
   address check is a convenience, not the guard.
5. `escrow.test.ts`, "a stranger cannot take it": the builder throws `/named buyer/`; forced past it with the token
   output pointed at the stranger, `chain.execute` returns false.
6. `buyBox.tokens(0) == tokenToSell` compares the whole pair, so the buyer's token box must carry exactly the sale's
   amount first; the builder puts only that token in it.

## `buildCancelEscrow` (the seller withdraws)

1. Throws `only the seller can cancel` (`:125`) and `the cancel needs one of the seller's boxes as the second input`
   when no input carries the seller's tree (`:127`).
2. Chain: the escrow box. User: nothing. The builder orders the inputs escrow first, one seller box second, and pins
   both with `ensureInclusion` (`:131-132`).
3. Output 0: the escrow's value and token back to the seller, R4 = the escrow id (`:128-130`). The script:
   `refundBox.tokens.size > 0 && refundBox.tokens(0) == tokenToSell && refundBox.propositionBytes == seller &&
refundBox.R4[Coll[Byte]].get == SELF.id && INPUTS(1).propositionBytes == seller && refundBox.value >= SELF.value`.
4. `INPUTS(1).propositionBytes == seller` is the only authorisation: a transaction whose second input is any box
   under the seller's tree may refund, and the seller's key is needed to spend that second input. Fleet's selector
   may reorder inputs it adds after the two pinned ones; the builder relies on `from([escrow, sellerBox, …])` keeping
   index 1 (checked by the test).
5. `escrow.test.ts`, "the seller cancels with one of their own boxes as the second input": `inputs[0]` is the escrow,
   `inputs[1].ergoTree` is the seller's, accepted. No forced case with a stranger's box at index 1.
6. The refund must carry at least `SELF.value`; the miner fee therefore comes from the seller's other inputs.

## Limits

- Rent: the escrow box holds one token on 0.001 ERG; after a storage-rent period (1,051,200 blocks) a rent claim
  consumes it whole. The page neither reserves rent nor warns; a sale is meant to close in days.
- The script fixes `OUTPUTS(0..2)` by index, so an escrow take cannot share a transaction with another escrow or a
  pool.
- The explorer lists an escrow as unspent until its take or cancel is in a block; the page re-reads the list three
  seconds after a submission (`src/ui/escrow.ts`, `reload`).

Properties: none.
