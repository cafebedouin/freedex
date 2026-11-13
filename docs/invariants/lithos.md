# LithosDex: invariants

Module `src/protocols/lithos/lithos.ts` (pool, vault and provision readers, the four order contracts, the order
builders, cancel, claim, the direct pool operations, `signerHints`); the tab `src/ui/lithos.ts`. Registry: `lithosdex-pool` (`2de640e37a49`),
`lithosdex-fee-vault` (`29956fe5b9d8`), `lithosdex-provision-guard` (`938b8ae08a16`), `lithosdex-provision-logic`
(a context variable, blake2b256 `245ef9157dbd`), `lithosdex-order-swap-sell` (`b4fd5d9be2ed`),
`lithosdex-order-swap-buy` (`7122d56978cf`), `lithosdex-order-deposit` (`28027ccf9c2a`), `lithosdex-order-redeem`
(`d67c6f6e4dfa`). Tests: `src/protocols/lithos/lithos.test.ts` (the builders against the record and their refusals),
`test/lithos-lib.test.ts` (the wallet library under the recorded headers; fixtures `test/fixtures/lithos-record.json`
and `test/fixtures/lithos-pool-record.json`), `test/ui/lithos.test.ts` (the tab),
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

## Direct pool operations (`buildSwap`, `buildDeposit`, `buildRedeem`, `buildFlush`, `buildResize`, `buildRefresh`)

The pool, the vault and the provision guard hold no key. The pool accepts any transaction that satisfies its
arithmetic (`LD_LiquidityPool.ergo`, `sigmaProp(poolPreserved && validAction)`, no key anywhere), so a wallet does in
one transaction what an order and an executor otherwise do, without the executor fee. Who may do what is the
provision logic's (`LD_Provision.ergo`): op 0 claim, op 1 redeem and op 3 resize require the provision's ownership
NFT among the inputs; op 2 refresh requires only age. The vault's flush path (`LD_FeeVault.ergo` op 1) requires
only the pool at input 0 under op 3 or 4. The record holds a direct swap (`a6633116`), a direct deposit
(`666028b4`), a direct redemption (`7b4cb642`), the one resize there has ever been (`4c91124c`, owner-made; the
provision token's 257 provision boxes on the explorer on 2026-11-12 show no other) and 8 flushes, all made by
wallets without an order.

1. Refusals are `LithosRefusal` with a `code`: `amount`, `pool-moved` (the pool pays less than `minOut`),
   `no-provision-tokens`, `min-supply` (supply under `MIN_SUPPLY`, 1000000), `same-size`, `zero-size` (a resize to
   nothing is a redemption), `no-owner-nft`, `nothing-pending` (the pool refuses a flush that moves nothing),
   `not-old-enough` (refresh before `refreshableAt`), `provision-value`, `order` (the fixed inputs moved). The
   readers' errors for boxes that are not the pool, vault or a provision.
2. Each takes the boxes as last read (`latestByToken` through the mempool). A pool box spent by anyone first makes
   the transaction invalid; it never executes at a worse price than built. Contention with the executors is the
   cost of skipping them.
3. Shapes (inputs and outputs at the positions the contracts read; Fleet's change and the 0.001 ERG fee after):
   - swap (op 0): pool → pool. The whole input enters the box; the side fee `amountIn * 15 / 10000` (truncated) goes
     to pending and `fee * 1e27 / supply` (truncated) onto the accumulator; the builder takes `quoteSwap`, the most
     the AMM inequality admits. What the pool pays lands in the change.
   - deposit (op 1): pool → pool, provision, NFT box. `depositCost(shares)`: both sides `ceil(shares * reserve /
supply)` (`LDLiquidityPool.simDepositForShares`). Provision box: `PROVISION_MIN`, one provision token, R4/R5
     the pool's R7/R8, R6 the pool box id, R7 the shares, no R8. The NFT is minted from the pool box's id (the pool
     is input 0) into `OWNER_BOX_VALUE` (0.001 ERG) at the owner, with the official client's EIP-4 registers
     (`LD-NFT-` and six hex digits, a JSON description, decimals `0`). The minimum the contracts allow is one share:
     at the pool of 2026-11-12 (block 1915217) one nanoERG and 6 LIT units, plus the 0.6 ERG provision box.
   - redeem (op 2 / provision op 1): pool, provision, NFT box → pool, payout. `shares * reserve / supply`
     (floored) of each side; the payout (output 1, the slot the provision logic reads) carries that ERG plus the
     provision box's value, and the LIT; the NFT is burned. Unclaimed fees stay in the vault for good.
   - flush (op 3 / vault op 1): pool, vault → pool, vault. Pool less exactly its pending, R6 `[0, 0]`; vault plus
     exactly that, R4/R5 the pool's R7/R8. Anyone; the caller pays the fee and is paid nothing.
   - resize (op 4 / provision op 3 / vault op 1): pool, provision, vault, NFT box → pool, provision, vault.
     `resizeQuote`: growing pays `ceil(delta * reserve / supply)` of each side, shrinking takes
     `floor(-delta * reserve / supply)`; the provision keeps its value, token and NFT, R7 the new size, R4/R5
     `acc - old * (acc - entry) / new` (what it had earned is preserved, rounded down by less than one share's
     worth, so no claim is needed first); the vault takes the pending fees and the accumulators (the flush is
     required on this path). Owner only.
   - refresh (provision op 2): provision → the same provision, its creation height the builder's height. Anyone,
     once `SELF.creationInfo._1 < HEIGHT - 525600`; the successor must be dated after `HEIGHT - 1000`. No box can
     reach that age until about two years after the deployment (the oldest provision box was created at block 1876058).
4. The contracts check the arithmetic; the builders only pick the extreme the contract admits (the most a swap or a
   redemption may take, the least a deposit or a grow may pay).
5. `lithos.test.ts`, "direct pool operations": for all 63 recorded pool transactions the builder's pool successor,
   and the provision and vault successors where there are any, equal the mined ones byte for byte with the recorded
   context variables (46 swaps, 1 of them wallet-made; 6 deposits; 2 redeems; 8 flushes; the resize). Intended
   difference: an executor's deposit (`LithosDexExecution.depositSplit`) fed the pool 0 to 2 LIT units more than
   `depositCost` for the same shares (2, 0, 1, 0, 0 in the five), so for those the provision box and the pool's
   registers are compared and the pool's ERG and LIT are at least ours. Wallet-made ones also match in what the
   wallet gained or lost per token and in ERG, the fee difference aside (the client paid 0.002), and the direct
   deposit's NFT box matches with its registers. `lithos-lib.test.ts`: under 0.29 and the recorded headers (20 of
   them: 8 flushes, 6 deposits, 2 redeems, 3 swaps, the resize) every LithosDex input reduces to true, signing with
   another key stops only at a wallet input, and the same transaction made by the throwaway key signs and verifies.
   Synthetic resizes from the recorded one's state (shrink to half, by one share, to one share; grow by one share, by
   a tenth) sign and verify; a shrink taking one nanoERG more, or with an entry one lower, makes the pool reduce to
   false. A synthetic provision box one block past `REFRESH_AGE` refreshes (true, signs, verifies); exactly at it,
   or with a successor dated `HEIGHT - 1000`, the logic reduces to false. 0.28.0 fails at parse on every version-3
   input of the 20.
6. Every input but the wallet's is version 3: a wallet library must parse version 3 to sign any of these. The
   signer needs `--allow-tree` only for a deposit's provision box; nothing but the wallet's key signs.

## Limits

- No direct swap or deposit form on the tab (the builders exist; the tab offers orders, and resize and flush).
- Token-to-token LithosDex pools (`LD_T2T_*`) are not read.
- A deposit order's LIT is computed at the pool's ratio from the ERG typed, rounded up; the deposit order refunds
  whichever side the pool does not take.
