# Changelog

Every entry is a push to `main` (one Pages run each); the commit is named. Dates are the commit dates.

## Unreleased (branch `lithos`): LithosDex, Machina's version-2 orders, ergo-lib-wasm 0.29

- ergo-lib-wasm 0.29.0 from sigma-rust `688511df` for both bindings, vendored in
  `vendor/ergo-lib-wasm-0.29.0-688511df/` until the npm release (0.28.0 cannot parse ErgoTree version 2 or 3). No
  call site changed.
- LithosDex (`src/protocols/lithos/lithos.ts`, the LithosDex tab, `docs/invariants/lithos.md`): swap, deposit and
  redeem orders, the owner's cancel, a provision holder's fee claim; eight registry entries. Checked against the
  record: 51 recorded order placements and 20 recorded claims rebuild byte for byte where the builder is
  deterministic; every cancel and claim reduces and signs under 0.29 and fails at parse under 0.28.0.
- Machina's version-2 limit order (`E2T_V2`, registry `machina-e2t-limit-order-v2`): read, filled, closed and
  placed; checked against 54 recorded version-2 order spends.
- LithosDex straight against the pool, no order: `buildSwap`, `buildDeposit`, `buildRedeem`, `buildFlush`
  (permissionless), `buildResize` (owner only; flushes in the same transaction) and `buildRefresh` (permissionless
  after 525600 blocks); refusals are `LithosRefusal` with a code. The tab offers resize beside claim, and flush while
  fees are pending. Checked against the 63 recorded pool transactions (`test/fixtures/lithos-pool-record.json`):
  the pool, provision and vault successors rebuild byte for byte; under 0.29 they reduce and sign, under 0.28.0 they
  fail at parse.
- `scripts/mainnet-run.ts`: unsigned LithosDex and Machina test transactions for an address, for a separate signer;
  a liquidity provider's cycle straight against the pool (P0 to P6), the deposit and redeem orders placed and
  cancelled (L6, L7), the `--max-loss` each needs, and the address's provisions in `status`.
- `ergo-lib-wasm-nodejs-028` (an npm alias of 0.28.0) for the library tests' negative control.
- Experimental marking: the LithosDex tab carries an "experimental" label and a notice at its top (exercised on
  mainnet with a library build that is not released yet; placing an order works on any wallet; cancel, claim,
  resize, flush and the direct pool actions need a wallet whose library reads ErgoTree version 3; Nautilus 1.4
  fails with `NonConsumedBytes` until it ships sigma-rust 0.29). The Limit orders tab marks version-2 Machina
  orders "v2" with a note that filling or closing one needs the same library; new orders are still version 1.
- Tip consistency (`src/tip.ts`, `docs/invariants/signing.md`): before any transaction reaches the signer, the
  boxes the page brought from the explorer are re-read by id; one spent, no longer known, or confirmed in a block
  the signer's side may not have (one confirmation against the browser wallet's height, two against the
  explorer's on the phone path) is refused with the wait stated. The phone's reduction refuses headers older than
  such a box. A wallet's `NonConsumedBytes`, and a node's double-spend and missing-input refusals, are said in
  words with what to do; an EIP-12 `{code, info}` error shows its text instead of `[object Object]`. The LithosDex
  claim reads the vault at the click.

## 2026-11-06: chaining off the mempool, and the bank's fee

- The bank box and the oracle box are read through `explorer.latestByToken`, which starts from the confirmed box
  and follows each unconfirmed transaction that spends it, the way tokenjay.app chains. Before this a SigRSV or
  SigUSD mint built on the confirmed bank box while someone's spend of it sat in the mempool, and every node
  refused it as an attempted double spend; the bank is spent every few blocks by a trading bot.
- The phone signer's boxes come from `explorer.unspentByAddressChained`: confirmed boxes a pending transaction
  spends are left out and that address's unconfirmed change is spendable, so a second transaction can follow the
  first without waiting for a block.
- `toFleetBox` also reads a register given as bare hex, the shape the explorer's OpenAPI schema gives mempool
  boxes; the live mempool listing carries the same `{serializedValue, …}` objects as confirmed boxes (2026-11-06).
- Pool reads chain the same way: `poolByNft` and `t2tPoolByNft` (every swap, deposit, redeem, program step and
  the upkeep runner's pool read) follow pending swaps on the pool to its newest box, so a swap is built after a
  pending one instead of against it.
- Bank transactions pay a 0.003 ERG miner fee (`BANK_FEE`), up from the page's usual 0.001. A bot's spend that
  reaches the mempool while the phone is signing still conflicts with the page's mint; at 0.001 ERG on about
  1,250 bytes the page's transaction lost that tie to the bot's 0.0011 ERG on about 1,190, and at 0.003 it wins
  it. The front page's fee line, the Bank tab's note, its quote (a "Miner fee" row) and its sentence before the
  wallet prompt say 0.003 ERG; the README's cost table names the exception.
- `test/chain.test.ts` (11 tests); `bank.test.ts` checks the fee output.

## v0.1.0, 2026-10-29: hardening

The commit this tag sits on. No builder's behaviour changed except one new refusal found by a property test.

- Invariants written down: `docs/invariants/` (pools, orders, bank, bonds, escrow, clock, option, upkeep, signing),
  one file per domain, each builder's preconditions, inputs, arithmetic against the contract line, what the
  contract refuses that the builder does not pre-check, the proving test by name, and the limits.
- Property-based tests with `fast-check` 4.10.2 in `test/properties/` (pools, units, sizing, clock, option), the
  mock chain as the oracle where a transaction is involved. Found: the ErgoDEX pool script multiplies the swap
  input by the fee numerator in Long before widening, so an input above `(2^63 - 1) / feeNum` (about 9.2 million
  ERG or 9.2e15 token units) cannot be evaluated by the script at all; `buildSwap` and `buildSwapT2T` now refuse it
  with "does not fit a Long" instead of handing the wallet a transaction the node would reject.
- A contract registry, `src/registry.json`: every contract the page builds against with its tree or template,
  template SHA-256, source and licence, and the date its hash was last checked against a mainnet box;
  `sigmafi-contracts.json` folded into it; every module reads its trees and hashes from it; `test/hashes.test.ts`
  checks every entry and recompiles the four contracts in `contracts/`; `scripts/registry-check.ts` asks the
  explorer for a box per entry.
- Scanning sized to the Actions budget: `npm audit --omit=dev` in the pages workflow, CodeQL weekly and on pull
  requests, Dependabot monthly in one grouped pull request, `SECURITY.md`.
- One browser test, on pull requests only: Playwright 1.64.1, Chromium, the built page from `dist/` under its CSP,
  the phone path to the QR panel with the WASM binding really instantiated, the `ergopay:` link within 2,800
  characters (`test/browser/phone.spec.ts`).
- Explorer resilience: a failed request is retried on the same backend after 1 s, 2 s and 4 s before the next
  backend is tried; every tab shows "explorer unavailable, retrying" while a listing loads or after it failed, with
  a retry button, and the header line says which try is running; the pool listing keeps being asked for every 30 s
  until it loads.
- Accessibility: every input labelled, the log and the status lines announced (`role="status"`,
  `aria-live="polite"`), the tabs wired as tabs and panels inside a `main` landmark, focus moved to the QR panel
  when it opens and returned on close, a sentence in words of what the wallet is about to be asked to sign before
  every prompt, the actions column named for screen readers; `axe-core` 4.14.0 runs over every tab in the happy-dom
  harness and reports nothing.
- Housekeeping: the protocol modules moved under `src/protocols/<name>/` with their tests beside them (ergodex,
  machina, babel, sigmausd, sigmafi, tokenjay, clock, option); `happy-dom` 20.14.6 to 21.0.4 (an advisory in the
  test harness); this changelog; the compatibility section in the README.

## 2026-10-29, `e595a95`: signing from the phone

ErgoPay in its static mode: a `Signer` over EIP-12 and the phone, the transaction reduced in the browser with
sigma-rust's WASM binding against the explorer's last ten headers, shown as a QR code and an `ergopay:` link, the
explorer polled for the id; "sign with your phone" in the header with the address kept in this browser; the
2,800-character size guard; the CSP gains `'wasm-unsafe-eval'`.

## 2026-10-29, `3d85f3c`: options

The option as a timed escrow (skunkyard SK-065): `contracts/Call.es` and `Put.es`, the builders (write, the keyless
buy, the buyer's exercise, the writer's reclaim and cancel), fourteen mock-chain cases a side, the Options tab,
the writer's reclaim of an expired option in the upkeep timer.

## 2026-10-29, `18e7575`: the tranche sale

`ClockSell.es` beside the clocked box; two fixes to the buy side (no rent reserve on an ERG box; the clock starts
at the first block the box can be mined in); the Bonds tab reordered.

## 2026-10-29, `77bfb53`: the clocked box

Skunkyard SK-064: `contracts/Clock.es`, the builders (create with the rent and length checks, the keyless leg
sized from the pool, cancel), eleven mock-chain cases, the `clock-legs` upkeep job in the page and the Node runner,
the Programs tab.

## 2026-10-29, `ccc645d`: one module per tab

One module per tab over a small store; UI tests in happy-dom; Prettier and ESLint in CI; Babel bids listed and
filled on the Limit orders tab; matured-bond collateral handed to the connected lender by the upkeep timer; "Your
positions" first on Bonds and Escrow; the explorer fallback line in the header; the source link in the footer.

## 2026-10-29, `59e2171`: review fixes

No `innerHTML` for chain-sourced text (a stored XSS through token names), a Content-Security-Policy, the slippage
minimum from the quote the user saw, "max" leaves a change box, explorer failover with timeouts and a listing
cache, a runtime explorer choice, pinned template hashes, tests for units, sizing and the keyless id, a
pull-request CI trigger.

## 2026-10-29, `4c5e5e2`: licence

CC0 1.0 for the project's own code; the SigmaFi-derived files keep their MIT notice in `THIRD-PARTY-NOTICES.md`.

## 2026-10-29, `ae64895`: Bank, Bonds and Escrow

SigmaUSD mint and redeem through Fleet's AgeUSD plugin (the bank quoted beside the pool on the Swap tab), SigmaFi
loans on their deployed contracts, TokenJay's escrow.

## 2026-10-29, `17764e8`: keyless upkeep

Babel bids and Machina orders priced across their pool, built with no signature, submitted through the explorer,
the bounty to the visitor; one checkbox to turn it off; the Node sidecar.

## 2026-10-29, `35b62b8`: token-to-token pools

Swap, deposit and redeem on the deployed T2T tree; both swap sides selectable; ERG pairs and token pairs on the
Pool tab; a deposit typed from either side.

## 2026-10-29, `e1a30b6`: Swap and Pool

The Swap tab on ErgoDEX v1 pools (a direct swap, no order box, no executor or interface fee), the Pool tab,
the static token whitelist, limit orders grouped by token; exact-integer explorer parsing; nine mainnet
transactions recorded.

## 2026-10-29, `d46c656`: first push

FreeDEX for Ergo: a self-hosted static page for Machina limit orders (list, create, fill, close); Fleet and the
Machina SDK in the browser, an EIP-12 wallet signs; mock-chain tests; the Pages workflow.
