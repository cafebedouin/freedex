# Changelog

Every entry is a push to `main` (one Pages run each); the commit is named. Dates are the commit dates.

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
