# Bonds: invariants (SigmaFi)

Module `src/protocols/sigmafi/bonds.ts`; registry entries `sigmafi-order-on-close-erg` (`525298e97a92`),
`sigmafi-order-on-close-token` (`05208404b335`), `sigmafi-bond-erg` (`44830db1e02b`), `sigmafi-bond-token`
(`edacb0e6bc89`), `sigmafi-dev-fee-recipient` (`55e36dd33c1a`); tests `src/protocols/sigmafi/bonds.test.ts`,
`test/upkeep-lender.test.ts`, `test/ui/upkeep.test.ts`, `test/ui/positions.test.ts`.

The contracts are used as deployed. Their ErgoScript is not published in `capt-nemo429/sigmafi-ui` (the repository
holds only the hex, `src/offchain/plugins.ts` at commit `309c1ac`, and its tree listing has no `.es` file) or in
`capt-nemo429/sigmafi-api`, so every "contract line" below is [UNVERIFIED] as source and is instead taken from the
constants of the deployed tree (`new ErgoTree(tree).constants`, printed in this session) and from the port's
arithmetic in `plugins.ts`. What the trees do carry, as segregated constants: the ERG order tree has `Long 500`,
`Long 100000`, the developer's `SigmaProp`, `Long 400` and the 32-byte blake2b-256 of the bond tree; the ERG bond
tree has `Int 0` and `Int 1` only (the maturity is read from R7, the lender from R8).

## `describeOrder`, `describeBond` (reading a box)

1. Throws `order box lacks a register` (R4 to R7 missing, `bonds.ts:72`), `not a SigmaFi open order` when the tree is
   not exactly `orderContract(principalId)` (`:74`); `bond box lacks a register` (R4 to R8, `:89`), `not a SigmaFi
bond` (`:91`). The principal token id is sliced from the tree at the template's first placeholder; a tree with the
   same template but other constants (another deployment of the script) is refused by the exact-tree check. On
   mainnet on 2026-10-29 one of twenty unspent boxes under the ERG order template hash carried a different bond-hash
   constant (`scripts/registry-check.ts`: "1 of 20 listed carry other constants"); the Bonds tab skips it.
2. Everything is read from the chain: R4 borrower (SigmaProp), R5 principal, R6 repayment, R7 term (order) or
   maturity height (bond), R8 lender (bond), the box's value as ERG collateral when above `SAFE_MIN_BOX_VALUE`
   (0.001 ERG, Fleet `core/dist/index.mjs:1170`), its tokens as token collateral. A bond carries no principal
   (`principal: 0n`, `:98`); the repayment is what the borrower owes.
3. No arithmetic.
4. Nothing; these do not build.
5. Not a refusal path; `test/ui/positions.test.ts` renders both.
6. A bond's `maturity` is compared with the explorer's height on the page (`src/ui/bonds.ts`, `left = maturity -
height`), which lags the node's by the explorer's indexing; see `buildLiquidate`.

## `buildOpenOrder` (the borrower's request)

1. Throws `the term must be under 1051200 blocks` when `term >= STORAGE_PERIOD` (`:124`; the same check as
   `plugins.ts:99`, `maturityLength >= STORAGE_PERIOD`), `the repayment must cover the principal` when `repayment <
principal` (`:125`). The page adds `name some collateral` when neither ERG nor a token is given
   (`src/ui/bonds.ts`, the `open-order` submit).
2. User: principal id and amount, repayment, term, collateral ERG and/or one collateral token and amount
   (`src/ui/bonds.ts` form `open-order`). Chain: nothing; the order box is new. The box value is the ERG
   collateral, or 0.001 ERG when the collateral is tokens only (`:126`).
3. None beyond the register encoding (R4 `SSigmaProp(SGroupElement(pk))`, R5 and R6 `SLong`, R7 `SInt`), the same
   registers as `plugins.ts:111-117`.
4. The order script is not evaluated at creation (a new box); whatever it refuses is refused at lend time.
5. Creation is exercised by `src/protocols/sigmafi/bonds.test.ts`, "borrower cancels" and the two following cases
   (the `open()` helper).
6. The term runs from the lend height, not the request height (`buildLend` sets R7 = lend height + term).

## `buildCancelOrder` (the borrower withdraws)

1. Throws `only the borrower can cancel` when the wallet's change address is not R4 (`:151`).
2. Chain: the order box (value and tokens back in one output). User: nothing.
3. None: `back = OutputBuilder(orderBox.value).addTokens(orderBox.assets)` (`:152`); the miner fee comes from the
   borrower's own inputs.
4. The script's borrower path needs the borrower's signature; a stranger forcing the build past the builder's check is
   refused by the proof, not by a register check. [UNVERIFIED] which other conditions the cancel branch imposes.
5. `bonds.test.ts`, "borrower cancels" (the accepted path). No forced-stranger case exists for the cancel.
6. None.

## `buildLend` (a lender closes the order into a bond)

1. Throws only what `describeOrder` throws. No check that the lender holds the principal: Fleet's selector throws
   at build when the inputs cannot cover the outputs.
2. User: nothing but the click (`src/ui/bonds.ts`, the "lend (+… dev fee)" button). Chain: the order box, whose R4
   and R6 are copied into the bond's R5 and R6; the lender's SigmaProp goes into R8 and into the order input's
   context variable 0 (`:171`), the bond's R4 is the order's id, R7 is `height + term` (`:179`).
3. Outputs, in this order (`:200`): the bond at 0 with the order's value and tokens; the principal to the borrower at 1
   (ERG, or 0.001 ERG plus the tokens); the developer fee at 2 to `DEV_FEE_TREE`; the "UI fee" at 3 to the lender.
   `devFee = 500 * principal / 100000` and `uiFee = 400 * principal / 100000`, both floor (`:107-108`), the same
   integer division as `plugins.ts:212-213` (`(500n * amount) / 100000n`, `(400n * amount) / 100000n`); the tree's
   constants `Long 500`, `Long 100000`, `Long 400` are the figures the script multiplies by. A token principal pays
   each fee as tokens on a 0.001 ERG box, or an empty 0.001 ERG box when the fee rounds to zero (`:187-196`).
4. The script decides whether the fee outputs, the bond's registers, the borrower's payout and the order of outputs
   are right; the builder checks none of these. It also decides whether R7's height is acceptable; the builder uses
   the wallet's height plus the term.
5. `bonds.test.ts`, "lender closes, borrower repays before maturity": the lender's balance drops by principal plus
   `devFee` plus the miner fee only, `uiFee(2 ERG)` equal to 8,000,000 nanoERG and back to the lender; `maturity`
   equal to the lend height plus 1,000. No case shaves a fee output; the "UI fee" to the lender's own address is
   what the deployed contract allows (it checks the amount against context variable 0, the address the closer
   names), not a page choice the script could refuse.
6. The maturity is the lend transaction's build height plus the term; a transaction mined later than built
   matures that much earlier in wall-clock terms. The lender's 0.4% is only "returned" if the lender's wallet is
   the one that closes; another front end's fee goes to that front end.

## `buildRepay` (the borrower settles)

1. Throws `only the borrower repays` when the wallet is not R5 of the bond (`:215`).
2. Chain: the bond box (R6 repayment, R8 lender, value and tokens as collateral). User: nothing.
3. Output 0: the repayment to the lender, R4 = the bond id (ERG, or 0.001 ERG plus the repayment in tokens); output 1:
   the collateral (the bond's value and tokens) to the borrower (`:217-225`). No rounding.
4. The script checks the repayment output's amount, address and R4, and that it is spent by the borrower's key
   before the maturity; [UNVERIFIED] whether it also checks the collateral output (the builder sends it all back).
5. `bonds.test.ts`, "lender closes, borrower repays before maturity": the lender's net gain equals repayment minus
   principal minus `devFee` minus the miner fee. No case repays one nanoERG short.
6. Repayment after maturity is not refused by the builder; whether the deployed script allows a late repayment while
   nobody has liquidated is [UNVERIFIED] here (the Bonds tab shows "repay" only while `left > 0`).

## `buildLiquidate` (after maturity, the collateral to the lender)

1. Throws `the bond matures at <height>` when `height < maturity` (`:240`).
2. Chain: the bond box, its R8 lender. User: nothing; `recipient` is only where the change goes, and the miner fee
   comes from the recipient's own inputs. Anyone may build it (`test/upkeep-lender.test.ts`, "the hand-over itself is
   keyless: a stranger's boxes pay the fee and nobody but the stranger signs").
3. Output 0: the bond's whole value and tokens to the lender, R4 = the bond id (`:242-244`). No arithmetic.
4. The script checks `HEIGHT >= R7` (the tree reads R7 as `Int`, `e4c6a70704`), the output's address, value, tokens
   and R4; the builder pre-checks the height only against the wallet's or explorer's height, which the node checks
   one block later.
5. `bonds.test.ts`, "after maturity anyone may hand the collateral to the lender; before, nobody can": the builder
   throws `/matures/` at the lend height and the transaction is accepted after `jumpTo(height + 1001)`. The "before,
   nobody can" half is proved by the builder's throw only; no forced early transaction is sent to the script.
6. The page's upkeep (`src/ui/upkeep.ts`) asks the wallet once per bond (`asked` set) when `maturedBondsFor` finds a
   matured bond whose lender is a wallet address and whose collateral exceeds the fee (`src/upkeep.ts:160-186`);
   `test/upkeep-lender.test.ts`, "picks the matured bond lent by the visitor and leaves the others" and
   `test/ui/upkeep.test.ts`, "asks the wallet to sign the collateral hand-over of the matured bond, once".

## Limits

- Height: the builders compare against the height the signer reports (`src/ui/wallet.ts`, the wallet's for
  EIP-12, the explorer's for the phone); the node validates at that height plus one, and the explorer's height can
  lag the node's by a block or more.
- Rent: an order or bond that holds token collateral is a token box; after one storage-rent period (1,051,200
  blocks) a rent claim can consume a box too small to pay the fee, tokens included. The builder bounds the term
  under the period but neither reserves rent nor warns.
- No partial repayment, no refinancing; the page builds only the four paths above plus cancel.

Properties: none (no property test covers this domain; the mock-chain cases above are the proof).
