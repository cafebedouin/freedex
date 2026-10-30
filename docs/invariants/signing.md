# Signing: invariants (EIP-12 and ErgoPay)

Modules `src/wallet.ts` (the `Signer` interface and the EIP-12 connector), `src/ergopay.ts` (the phone),
`src/ui/wallet.ts` (`send`, the one path every tab's transaction takes, and the QR panel), `src/ui/swap.ts` (the
slippage minimum). No registry entry: nothing here is a contract. Tests `test/ergopay.test.ts`,
`test/ui/phone.test.ts`, `test/ui/swap.test.ts`, `test/ui/header.test.ts`.

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

1. Throws `connect a wallet first` with no signer. Everything else is the builder's or the signer's.
2. The page builds: `height` from the signer (`wallet.ts:49`, `api.get_current_height()`; the explorer's height for
   the phone), `inputs` from the signer's full unspent list (`get_utxos()`, or `unspentByAddress` less the boxes a
   phone-signed transaction spent, `ergopay.ts:127-131`), then the tab's builder with those. Fleet's
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
6. After a submission the listings cache is dropped (`store.explorer.invalidate()`, `:26`).

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
   `SPENT_MEMORY_MS` (15 minutes, `:22`, `:129`), because the explorer lists them as unspent until the block. A
   box spent by another wallet meanwhile is unknown to the page until the explorer drops it; the node then refuses
   the transaction. Cancel only stops the page's wait; a phone that already scanned may still sign and submit, and
   the id is then seen by the next build's explorer reads, not by this one.

## Limits

- The reduction's context takes the newest header as the pre-header (height H) while the node validates at H + 1,
  the same as Nautilus; a script that becomes true exactly at H + 1 (a bond at its maturity, an option at its
  expiry, a leg at its due height) reduces at H and can reduce to a different proposition than the node checks. The
  builders refuse one block early for that reason (`clock.md`, `option.md`).
- `Parameters.default_parameters()` are the genesis defaults, not the live ones (the cost limit, the minimum value
  per byte); a transaction near those limits may reduce here and fail there.
- The explorer's height lags the node's; the phone path builds at the explorer's height, the EIP-12 path at the
  wallet's.
- The QR limit is the page's 2,800 characters; a transaction with a dozen or more inputs is refused with the note to
  consolidate first.

Properties: `test/properties/pools.test.ts` (the `minOut` refusal).
