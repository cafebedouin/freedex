# Signing: invariants (EIP-12 and ErgoPay)

Modules `src/wallet.ts` (the `Signer` interface and the EIP-12 connector), `src/ergopay.ts` (the phone),
`src/ui/wallet.ts` (`send`, the one path every tab's transaction takes, and the QR panel), `src/tip.ts` (the check of
the boxes the page brought, and the signer's refusals in plain words), `src/ui/swap.ts` (the slippage minimum). No
registry entry: nothing here is a contract. Tests `test/ergopay.test.ts`, `test/tip.test.ts`, `test/chain.test.ts`
(`boxState`), `test/ui/phone.test.ts`, `test/ui/swap.test.ts`, `test/ui/header.test.ts`, `test/ui/lithos.test.ts`.

## What the page holds

- No key and no seed on either path. EIP-12: the wallet extension holds the keys; the page receives addresses,
  boxes, balances and a height through `getContext()` (`wallet.ts:43-57`). Phone: the page holds a mainnet address
  typed by the visitor and reads boxes and balances for it from the explorer (`ergopay.ts:118-135`).
- `localStorage` holds two keys only: `freedex.explorer` (the chosen backend, `explorer.ts`) and `freedex.phone` (the
  typed address, `ergopay.ts:23`, written by `src/ui/wallet.ts`, `storePhone`). Nothing else is written anywhere.
  Proof: `test/ui/phone.test.ts`, "asks for the address once, keeps it in this browser, and reads balances from the
  explorer" (`localStorage.getItem("freedex.phone")` equals the address).
- The page phones nobody but the explorer backends in `EXPLORERS` (and one the visitor types in the header); the
  CSP in `index.html` allows scripts from `'self'` only.

## `send` (every tab's path, `src/ui/wallet.ts`)

1. Throws `connect a wallet first` with no signer; the tip check's refusals (next section); and, when the signer
   fails, an Error whose message is `explainFailure` of what it threw (next section). Everything else is the
   builder's.
2. The page builds: `height` from the signer (`wallet.ts:49`, `api.get_current_height()`; the explorer's height for
   the phone), `inputs` from the signer's full unspent list (`get_utxos()`, or for the phone
   `unspentByAddressChained`: the confirmed boxes less those a pending transaction spends, plus that address's
   unconfirmed change, `explorer.ts` `chainUnspent`; then less the boxes a phone-signed transaction spent,
   `ergopay.ts`), then the tab's builder with those. Fleet's
   `TransactionBuilder` selects the inputs it needs from that list, adds the change output to `changeAddress` and
   the miner fee output of `FEE` (0.001 ERG, `orders.ts`). The transaction the wallet sees is complete: inputs,
   outputs, fee, change.
3. No arithmetic.
4. What the wallet decides (EIP-12): whether to sign at all (the visitor's confirmation in the extension), and the
   submission through `submit_tx` (`wallet.ts:52-55`; `eip12-types/lib/index.d.ts:188`, `:207`). The wallet does not
   add or remove inputs or outputs: `sign_tx` signs the object it is given, so a transaction whose fee or change the
   wallet dislikes is refused, not amended. What the wallet decides (phone): the same confirmation on the phone's
   signing screen, and the submission by the phone; the page only watches the explorer for the id.
5. `test/ui/swap.test.ts`, "with a wallet, a changed amount that was never quoted is refused as stale";
   `test/ui/upkeep.test.ts`, "asks the wallet to sign the collateral hand-over of the matured bond, once" (the
   object handed to `sign_tx` is the built transaction); `test/ui/phone.test.ts`, "shows the code and link for a
   swap, waits, and reports the id the explorer lists".
6. After a submission the listings cache is dropped (`store.explorer.invalidate()`). Between the build and the
   signer, `checkInputs` runs (next section); the signer is called only if it passes.

## Tip consistency (`src/tip.ts`, run by `send` between the build and the signer)

The page reads contract boxes (pools, the bank and oracle, orders, provisions, the vault) from the explorer; the
transaction is checked and submitted by another node, the browser wallet's or the phone wallet's, which can be a
block or more behind or ahead. In a run of 25 mainnet transactions built by these builders and signed by a separate
command-line signer, three were built on a box the explorer already listed, created one block earlier, while the node
used to check and submit them was still a block behind and answered 404 for it; the signer refused before signing.

1. `checkInputs` throws a `TipRefusal` with a `code`, and nothing is signed:
   - `spent`: `box <id>… was spent by transaction <id>… after the page read it; nothing was signed; press the button
again to rebuild against the newest boxes`;
   - `not-visible`: `box <id>… is no longer known to the explorer (spent in the mempool and gone from its listing, or
its block was rolled back); nothing was signed; press the button again to rebuild against the newest boxes`;
   - `too-fresh`: `box <id>… was confirmed in block <S>; your wallet reports block <R>, so its node may not have that
block yet. Nothing was signed: wait <n> block(s) (about <2n> minutes) and press the button again` (EIP-12), or
     `…; the explorer is at block <H>, and the phone path waits for 2 confirmations so the phone's node has it too.
Nothing was signed: wait …` (phone).
     A failed read of a box throws the explorer's error: the page does not hand over what it could not check. The
     phone's reduction also throws `the explorer's newest header is block <h>, older than block <S> that holds an
input: …; nothing was reduced; try again in a minute` (`reduceTransaction`, `newestInput`).
2. Read: every input and data input of the built transaction that the signer did not hand over (`send` passes the
   signer's own box ids), each by id from the explorer right then (`Explorer.boxState`, `/api/v1/boxes/<id>`, not
   cached): the height of the block holding it and the transaction that spent it. A 404 for a mempool output the page
   itself followed (`latestByToken`) is a mempool box. The signer's height is the one the build used.
3. The rule: a confirmed box at height `S` passes when `S + MIN_CONFIRMATIONS - 1 <= R`, where `R` is the signer's
   height and `MIN_CONFIRMATIONS` is 1 for EIP-12 (the wallet reports its own node's height, so one confirmation means
   that node has the block) and 2 for the phone (the only height is the explorer's, the same source as the box, so
   one block of margin). A mempool box the page followed passes: building on a pending transaction is on purpose
   (the bank and pools, `latestByToken`). The visitor's own boxes are not checked: the browser wallet gave them; on
   the phone path they come from the explorer with the mempool counted (`unspentByAddressChained`).
4. What the page cannot decide: whether the signer's node has a mempool box the page followed, and anything that
   happens between this read and the node's check. A box spent there, or a node that is behind, makes the node
   refuse, and the wallet reports it. `explainFailure` turns the refusals it recognises into plain words, the wallet's
   or node's own text kept in brackets: `NonConsumedBytes` (the wallet's library does not parse ErgoTree version 2 or 3) gives `your wallet could not read a contract this transaction spends: its signing library does not parse
ErgoTree version 2 or 3 (Nautilus 1.4 fails this way, with NonConsumedBytes, until it ships sigma-rust 0.29).
Nothing was signed. See the experimental note at the top of the tab`; the node's `Double spending attempt` gives
   `the node refused it as a double spend: a box it spends (a pool, the vault or another shared box) was spent by
someone else's transaction first. Nothing of yours moved; press the button again to rebuild against the newest
boxes`; `Every input of the transaction should be in UTXO`, `Missing inputs` or `Box with id … not found` give
   `the wallet's node does not have one of the boxes it spends: the box was spent already, or that node is behind
the explorer this page reads. Nothing of yours moved; wait a block (about 2 minutes) and press the button again`.
   Anything else is shown as the wallet's text; an EIP-12 `{code, info}` object shows its `info` (`failureText`,
   also the tabs' `err`), never `[object Object]`. Rebuilding is pressing the same button: every action that spends
   a shared box reads it again by token first (the pools by NFT, the bank, the LithosDex pool and vault; a LithosDex
   claim reads the vault at the click, not the one listed).
5. `test/tip.test.ts` (the rule on both paths, the waits, `spent` and `not-visible`, only the boxes the signer did not
   give are asked, the refusals in words); `test/chain.test.ts`, "boxState: …" (confirmed, spent, a followed mempool
   output, unknown); `test/ergopay.test.ts`, "refuses headers whose newest is older than the newest block holding an
   input" and "refuses to reduce when the explorer's headers are older than a box the page brought, before showing
   anything"; `test/ui/lithos.test.ts`, "refuses a cancel whose order box the explorer has seen spent since the
   listing; the wallet is not asked", "refuses a flush on a pool box confirmed in a block the wallet does not report
   yet, and says how long to wait" (and builds once the wallet has the block), "says what NonConsumedBytes from the
   wallet means and points at the experimental note", "says a node's double-spend refusal in plain words, with the
   rebuild"; `test/ui/phone.test.ts`, "does not reduce a swap on a pool box confirmed in the explorer's newest block:
   two confirmations on this path".
6. Still possible, and how it shows: (a) a box spent between the re-read and the node's check (the LithosDex pool is
   spent about 845 times in 10,000 blocks, a few seconds of exposure here plus however long the visitor takes to
   confirm in the wallet): the node refuses, the wallet reports it, the log says the double-spend sentence above;
   (b) a wallet whose node is behind but reports a height it does not have, or a phone wallet's node more than one
   block behind the explorer: the node refuses with the missing-input sentence (EIP-12), or, on the phone, the phone
   shows the node's error and the page's wait ends after 20 minutes with `no transaction … seen in 20 minutes; build
it again to retry` (the page never sees the phone's submission); (c) a mempool box the page followed that the
   signer's node does not have: the node refuses, as (b); (d) one extra explorer request per box the page brought
   (at most four on the LithosDex tab, one or two elsewhere), and the action waits for them.

## The slippage minimum comes from the quote the visitor saw (`src/ui/swap.ts`)

1. `swap-go` throws `the quote is stale; type the amount again` when the amount in the box differs from the amount
   of the quote on screen (`swap.ts`, `shown.amountIn !== amountIn`); `buildSwap` and `buildSwapT2T` throw `the
pool would pay <out>, below the minimum <minOut>` (`amm.ts:96`, `:315`).
2. The user sets the amount and the slippage tolerance (percent with two decimals, `slippageBps`, `:142-144`). The
   quote and `minOut = out - out * bps / 10000` (floor) are computed from the pool listing on screen and kept in
   `shown` (`:229-230`); the pool is then re-read by NFT right before the build (`poolByNft`, `:260`, `:265`) and the
   builder is given the fresh box with the old `minOut` (`:262`, `:267`).
3. Rounding against the visitor: `out` is the pool's floor; the minimum is `out` less a floored share of it.
4. The pool script does not know the minimum; it checks its own rule on the fresh reserves. The refusal is the
   builder's (`out < minOut`), before any wallet is asked. A pool that moved in the visitor's favour builds at the
   fresh, larger `out`.
5. `src/protocols/ergodex/amm.test.ts`, "the slippage guard refuses a stale quote" (`minOut: out + 1n` throws
   `/below the minimum/`); `test/ui/swap.test.ts`, "with a wallet, a changed amount that was never quoted is refused
   as stale". The property `test/properties/pools.test.ts` (a swap built with `minOut` one above the quote is
   refused by the builder) extends the first.
6. The guard is per build: between the re-read and the block the pool may still move, and then the pool script,
   not the page, refuses; the wallet shows nothing wrong, the node rejects. A bank quote shown beside the pool's is
   never chosen for the visitor (`:202-226`).

## The EIP-12 connector (`src/wallet.ts:36-59`)

1. Throws `no EIP-12 wallet found`, `wallet "<name>" not found`, `connection refused` (`:37-41`).
2. From the wallet: the change address, the used addresses (for "(you)" marks and the upkeep's lender and writer
   checks), the height, the unspent boxes, balances by token id. The page sets nothing.
3. None.
4. The wallet decides the connection (the visitor's grant), and may hand back fewer boxes than it holds (the page
   builds from what it gets).
5. `test/ui/header.test.ts` and every `connect()` in `test/ui/*.test.ts` (the stub in `test/ui/harness.ts`,
   `installWallet`).
6. `get_current_height` is the wallet's view of the chain; builders that compare heights (bonds, clock, option)
   compare against it, and the node checks the next block.

## The phone (`src/ergopay.ts`)

1. `parsePhoneAddress` returns `no address given`, `not an Ergo address`, `not a mainnet address (mainnet addresses
start with 9)` (`:46-57`). `reduceTransaction` throws `need the last 10 block headers, the explorer gave <n>`
   (`:71-72`). `sign` throws the size guard's text, `the reduced transaction is <n> characters, above the 2800 a QR
code can carry; build it from fewer inputs (consolidate your boxes with one send-to-self from the wallet
first)` (`:37-43`, `:137-138`), `cancelled; nothing was submitted unless the phone already did` (`:148`), and `no
transaction <id>… seen in 20 minutes; build it again to retry` after `POLL_TIMEOUT_MS` (`:142`, `:150-154`).
2. User: the address once (kept in this browser). Chain: the boxes by address, the height, the last ten headers
   (`HEADERS_NEEDED`, `:18`), the explorer's view of the mempool and of blocks for the id.
3. The reduction (`:70-84`): `BlockHeaders.from_json` of the ten newest headers, the newest as `PreHeader`,
   `ErgoStateContext(pre, headers, Parameters.default_parameters())`, inputs and data inputs in full from the EIP-12
   object, `ReducedTransaction.from_unsigned_tx`; the id is `UnsignedTransaction.id()`, the same before and after
   signing. The link is `ergopay:` plus URL-safe, padded base64 of the reduced bytes (`:26-34`), which is the
   encoding the reference wallet's `ErgoPay.buildStaticSigningRequest` writes (recorded in `skunks/dexpage/RESULT.md`).
   Guard: at most `QR_MAX_CHARS` = 2,800 characters (`:16`), under EIP-20's figure of about 2,900.
4. The phone wallet decides whether to sign and submits itself; the page never sees the signed bytes. The explorer
   decides when the id is "seen": `/transactions/<id>` for a block, `/mempool/transactions/byAddress/<address>` for
   the mempool, a failing request counting as not seen (`explorer.ts`, `seen`).
5. `test/ergopay.test.ts`: "is base64 with the URL-safe alphabet, padded", "guards the QR size at 2,800 characters"
   (2,094 bytes fit at exactly 2,800; 2,100 bytes are 2,808 and refused), "takes a mainnet address and refuses the
   rest", "reduces a mock-chain transaction through the binding against mainnet headers, with Fleet's id", "wants
   ten headers", "reads boxes and balances from the explorer, as EIP-12 boxes", "shows the code, polls until the
   explorer sees the id, then leaves those inputs out", "gives up after the timeout, and on cancel", "refuses a
   transaction too large for a code before showing anything". `test/ui/phone.test.ts`: "refuses an address that is
   not mainnet", "cancel stops the wait", and "is refused with the size, and nothing is shown".
6. Spent-input memory: the inputs of a transaction the explorer has seen are left out of the next build for
   `SPENT_MEMORY_MS` (15 minutes, `:22`), a backstop for the window before the explorer's mempool listing carries
   the transaction. A box spent by another wallet is left out once that spend is in the explorer's mempool listing
   (`chainUnspent`); before then the node refuses the transaction as a double spend. Cancel only stops the page's wait; a phone that already scanned may still sign and submit, and
   the id is then seen by the next build's explorer reads, not by this one.

## Limits

- The reduction's context takes the newest header as the pre-header (height H) while the node validates at H + 1,
  the same as Nautilus; a script that becomes true exactly at H + 1 (a bond at its maturity, an option at its
  expiry, a leg at its due height) reduces at H and can reduce to a different proposition than the node checks. The
  builders refuse one block early for that reason (`clock.md`, `option.md`).
- `Parameters.default_parameters()` are the genesis defaults, not the live ones (the cost limit, the minimum value
  per byte); a transaction near those limits may reduce here and fail there.
- The explorer's height can lag or lead the node's; the phone path builds at the explorer's height, the EIP-12 path at
  the wallet's, and the tip check above compares the boxes the page brought against that same height.
- The QR limit is the page's 2,800 characters; a transaction with a dozen or more inputs is refused with the note to
  consolidate first.

Properties: `test/properties/pools.test.ts` (the `minOut` refusal).
