# LithosDex: invariants

Module `src/protocols/lithos/lithos.ts` (pool, vault and provision readers, the four order contracts, the order
builders, cancel, claim, `signerHints`); the tab `src/ui/lithos.ts`. Registry: `lithosdex-pool` (`2de640e37a49`),
`lithosdex-fee-vault` (`29956fe5b9d8`), `lithosdex-provision-guard` (`938b8ae08a16`), `lithosdex-provision-logic`
(a context variable, blake2b256 `245ef9157dbd`), `lithosdex-order-swap-sell` (`b4fd5d9be2ed`),
`lithosdex-order-swap-buy` (`7122d56978cf`), `lithosdex-order-deposit` (`28027ccf9c2a`), `lithosdex-order-redeem`
(`d67c6f6e4dfa`). Tests: `src/protocols/lithos/lithos.test.ts` (the builders against the record and their refusals),
`test/lithos-lib.test.ts` (the wallet library under the recorded headers), `test/ui/lithos.test.ts` (the tab),
`test/hashes.test.ts` (the registry). Sources: Lithos-Protocol/Lithos-Client at `14ad1fe6`,
`lithos-lib/src/main/resources/lithosdex/LD_*.ergo` and `lithos-lib/src/main/scala/lithosdex/contracts/LDOrderContracts.scala`.

Every LithosDex script is ErgoTree version 3. A wallet signs an input under one only if its library parses version 3
(ergo-lib-wasm 0.29, vendored here until its npm release; 0.28.0, which Nautilus 1.4 ships, fails with
`NonConsumedBytes`). Placing an order spends only the wallet's boxes; a cancel spends the order box; a claim spends
the vault and provision boxes.

## Pinning

1. `checkDeployment` (run at load) throws unless the pool tree's constant 15 is blake2b256 of the guard tree, its
   constant 16 the vault NFT, the vault tree's constants 17 and 28 the provision token and the pool NFT, and the
   guard's constant blake2b256 of the provision logic; the logic itself must hash to its registry entry. So the
   pool tree, pinned in full, pins the guard, which pins the logic.
2. An order tree is the client's pinned sentinel tree with each term's constant replaced (`orderTree`); the loader
   throws unless each parameter index holds its sentinel and the sample hashes to the entry. `describeOrder` picks
   the kind by template hash, reads the terms from the constants, rebuilds the tree from them and accepts the box
   only if the rebuilt tree equals its tree byte for byte; a non-key owner, a constant of another type or garbage
   is `undefined`.
3. `describePool`, `describeVault` and `describeProvision` throw unless the box's tree is the pinned tree and its
   tokens are the deployment's (pool NFT, LIT, provision token; vault NFT and LIT; one provision token). Of the 20
   live boxes the explorer listed under the guard's template on 2026-11-12, 13 carry another deployment's
   constants and are refused.

## Placing an order (`buildSwapOrder`, `buildDepositOrder`, `buildRedeemOrder`)

1. Throws `amountIn must be positive`, `minOut must be positive`, `both sides of a deposit must be positive`,
   `minShares must be positive`, `the executor fee must be above the most it may spend on the miner fee`,
   `the owner must be a P2PK address`, `the pool has no provision tokens left to hand out`, and the readers' errors
   for a box that is not the pool or the provision.
2. The user sets the amounts and the minimum (the tab: the pool's quote less a slippage percentage); the executor
   fee defaults to 0.003 ERG and the miner-fee cap to 0.001 ERG, the official client's defaults, which its
   executors accept. The pool box is the newest by NFT through the mempool (`latestByToken`).
3. Box values, as `LDOrderTransactions` computes them: ERG in, `amountIn + executorFee + RETURNED`; LIT in,
   `RETURNED` and the LIT; deposit, `amountX + PROVISION_MIN + executorFee + RETURNED` and the LIT; redeem,
   `RETURNED` and the ownership NFT. `RETURNED` is 0.001 ERG. `quoteSwap` mirrors the order contract's check: the
   pool's side fee truncated off the input, then `floor(rOut * traded * feeNum / (rIn * 10000 + traded * feeNum))`
   on the reserves (held less pending).
4. The order contract checks the fill, not the placement. A minimum above the pool's quote is a limit order that
   waits. The redeem order does not claim first: a redemption leaves unclaimed fees in the vault for good (the tab
   says so before the prompt).
5. `lithos.test.ts`, "placing an order: the builder's order box is the recorded one": all 51 order boxes in the
   record (43 ERG-in swaps, 2 LIT-in, 5 deposits, 1 redeem) rebuilt from their placing transactions' inputs equal
   the mined box (tree, value, tokens, creation height). Intended differences: the page's 0.001 ERG miner fee (the
   official client paid 0.002, another front end 0.0011), no front-end tag in R4 (21 recorded orders carry
   `0e034d6577`, "Mew"), no interface fee (7 placements by that front end also paid a third address about 1.4%).
6. Order execution is the Lithos executors' (the pool spent with orders at heights 1914840 and 1915063 on
   2026-11-12); the page neither executes nor watches. An order whose fill would leave a reward box under 0.001 ERG
   is skipped by the executor.

## Cancelling (`buildCancel`)

1. Throws `not a LithosDex order box` and `only the order's owner can cancel it`.
2. The order box from the listing; the owner's boxes.
3. The order box is input 0. Without the pool at input 0 no order contract reads an execution, so the script is
   its refund path, the owner's key. The fee comes from the order when what is left makes a box, otherwise from the
   owner's boxes; everything goes to the owner's change.
4. The node checks the owner's signature on the order input.
5. `lithos-lib.test.ts`, "the page's cancels of every recorded order": for each of the 51 recorded order boxes the
   order input reduces to `proveDlog` of the order's owner under ergo-lib-wasm 0.29, signing with another key stops
   at input 0 for lack of it, and the same order owned by a throwaway key signs and verifies. 0.28.0 fails at parse.
6. A wallet signs the order input only through a library that reads version 3. On the phone path the page reduces
   the transaction itself; the Ergo mobile wallet then shows and signs a cancel (its outputs are P2PK and the fee).

## Claiming fees (`buildClaim`)

1. Throws `a claim settles at least one provision`, `provision … has nothing to settle: the vault has not been
flushed since`, `the vault can pay … nanoERG of the … owed`, `the vault holds … LIT units of the … owed`,
   `no wallet box holds the ownership NFT …`, `claim inputs out of order`.
2. Anyone holding a provision's ownership NFT can claim; nobody is paid by name. Needed: the vault box (by NFT), the
   provision box(es) (guard tree, R6 = the NFT id), a wallet box holding each NFT, and boxes for the fee.
3. Inputs: the vault with context variables 0 = `SByte 0` (claim) and 1 = `SInt n`, the provisions with 0 =
   `SByte 0` and 64 = the provision logic, then the NFT boxes and the rest. Outputs: the vault less exactly what is
   owed (`owed`: `shares * (acc - entry) / 1e27` per side, truncated), its R4 and R5 unchanged; each provision
   unchanged but R4 and R5 set to the vault's accumulators. The released ERG and LIT land in the owner's change.
4. The vault refuses a provision whose entries are not behind its accumulators, and caps the release at what is
   owed; the provision logic requires the NFT among the inputs.
5. `lithos.test.ts`, "claiming fees: the builder's claim is the recorded one": all 20 recorded claims rebuild to the
   recorded vault and provision successors byte for byte with the recorded context variables, and the claimant's
   change carries the same tokens; its ERG differs by the fee only. `lithos-lib.test.ts`: under 0.29 the vault and
   provisions reduce to true and the wallet box to the wallet's key; a synthetic claimant with the throwaway key
   signs and verifies; 0.28.0 fails at parse on all 40 version-3 inputs.
6. A claim's outputs are version 3, which the Ergo mobile wallet cannot display (it refuses to sign), and most
   claims are larger than a static QR code. A wallet with a version-3 library is needed.

## What the signer needs (`signerHints`)

`allowTrees`: output scripts that are neither the owner, the fee contract nor an input's own script (a placement's
order tree). `signTrees`: inputs other than the owner's P2PK that reduce to the owner's key (a cancel's order).
`v3Inputs`: inputs under ErgoTree version 2 or later. A claim needs neither list: its vault and provisions reduce to
true.

## Limits

- No direct swap, deposit or redemption against the pool (the pool is keyless and the record holds such
  transactions); every trade here goes through an order and an executor fee.
- Token-to-token LithosDex pools (`LD_T2T_*`) are not read.
- A deposit's LIT is computed at the pool's ratio from the ERG typed, rounded up; the deposit order refunds
  whichever side the pool does not take.
