# FreeDEX for Ergo

A decentralized exchange front end you can host yourself: static files, no server, no keys in the page, no fee of
its own.

Live: https://cafebedouin.github.io/freedex/

The name follows the BSD convention, and the adjective means what Stallman meant: free as in freedom, and also as in
beer. Free to run, free to fork, free of anyone's server, and free of interface fees.

## What it does

- **Swap** on [ErgoDEX v1](https://github.com/spectrum-finance/ergo-dex) pools (the pools Spectrum and Mew trade
  on), ERG-to-token and token-to-token, straight against the pool box in one transaction. No order box, no
  off-chain executor, no interface fee. The page quotes from the pool's own rule, shows the price impact, and refuses
  to build if the pool has moved past your slippage tolerance. Two tokens without a direct pool are two swaps through
  ERG.
- **Limit orders** on [Machina Finance](https://github.com/machinafi/sdk): place one, fill one, close your own.
  Open orders are grouped by token, best price first on each side. [EIP-31](https://github.com/ergoplatform/eips/blob/master/eip-0031.md)
  Babel boxes, standing bids anyone may sell tokens into, are listed beside them (marked "Babel") and filled the
  same way.
- **Pool**: add or remove liquidity on the same pools, ERG pairs and token pairs, straight to the pool box by its own
  rule. Type either side of a deposit and the other fills in at the pool's ratio. LP tokens are plain tokens in your
  wallet.

- **Bank**: mint or redeem SigUSD and SigRSV directly against the SigmaUSD bank at the oracle price, through Fleet's
  AgeUSD plugin with no implementor fee. The bank's own 2% protocol fee applies. The Swap tab quotes the bank beside
  the pool for these two tokens and says which is better; it never picks for you.
- **Bonds**: SigmaFi peer-to-peer loans on their deployed contracts. Request a loan against collateral, fund one,
  repay before maturity, or take the collateral after. SigmaFi's contract pays a 0.5% developer fee to its author on
  every loan, which the page shows and cannot remove; the contract's 0.4% "interface fee" is paid to the lender's own
  address here, so it returns to them. The request form comes first, then your own requests and bonds, then the market, collapsed.
- **Escrow**: a token sale to one named buyer at an ERG price on TokenJay's deployed escrow contract. The contract
  demands a small fee box, which the page pays to the seller, so a sale costs the miner fee only. Your own escrows
  first, then every other open one on the contract.
- **Programs**: clocked boxes, this project's own contracts (`contracts/Clock.es` and `contracts/ClockSell.es`,
  chartered as skunkyard SK-064). **Buy**: lock an ERG budget to be bought in slices, one every N blocks, from the
  token's deepest ErgoDEX pool, the tokens to your address (dollar-cost averaging with no custodian and no key but
  yours). **Sell**: lock a token amount to be sold in slices into the same pool, the ERG to your address (a tranche
  sale). Anyone may run a leg once its interval has passed, for the executor fee you set (the page's own upkeep and
  the Node runner do); each leg must deliver at least the pool's own rule for the slice, less your tolerance, and
  an optional price cap (buy) or floor (sell) makes the program wait while the pool is dearer or cheaper. What the
  box locks beyond its legs differs by side: a buy program holds no storage-rent reserve, because a rent claim on
  an ERG box left for four years takes its fee from the budget and leaves a smaller program; a sell program holds
  one rent fee for its bytes (about 0.89 ERG), because a token box that cannot pay rent is consumed whole, tokens
  included, and gets it back with the last leg. The box's clock is its creation height, set to the first block it
  can be mined in. Cancel any time, everything back.
- **Options**: the covered call and the cash-secured put as a timed escrow, this project's own contracts
  (`contracts/Call.es` and `contracts/Put.es`, chartered as skunkyard SK-065). An option here is a limit order you
  are paid to hold open, that you cannot cancel until a date: a **call** locks tokens and names a strike, an expiry
  height and a premium; whoever pays the premium becomes the named buyer and may buy the tokens at the strike at or
  before the expiry; after it the writer reclaims them, and the premium is the writer's either way. A **put** is
  the mirror: the writer locks the ERG collateral (strike x amount) and the buyer may sell them the tokens at the
  strike. Until it is sold the writer may cancel; once sold, only the buyer's exercise or the writer's reclaim after
  the expiry can spend the box. What it is: fully collateralized, no leverage, nothing to liquidate, no price feed,
  no fee to anyone. What it is not: transferable. The buyer is an address written into the box, not a token, so the
  right cannot be resold; SigmaO and Etcha are the token-based options on Ergo. No partial exercise. A call box
  holds one storage-rent fee for its bytes (back on exercise or reclaim); a put box holds the collateral only.
- **Chain upkeep while you are here.** With a wallet connected, the page looks every few minutes for boxes anyone
  may act on for a bounty, builds those transactions with no signature and none of your funds, submits them through
  the explorer, and sends the bounty to your address. Today's jobs: Babel bids (EIP-31) priced above their token's
  pool, Machina limit orders priced across the pool, either side, and the legs of clocked programs that are due. Default on, one checkbox to turn off. It never
  touches your own transaction, so a contended box costs you nothing but a log line. The same jobs run headless
  from Node (`scripts/upkeep-run.ts <address>`), which is the sidecar for anyone who wants to keep the chain tidy
  without a browser open. Two more jobs need your wallet: if a SigmaFi bond you lent on has matured, the page builds
  the transaction that hands you the collateral (the contract lets anyone do that; the miner fee comes from your
  change) and asks your wallet to sign it, once per bond; and if an option you wrote has expired, it builds the
  reclaim the same way, once per box.

The swap and pool token lists are a static whitelist of tokens whose deepest pool held 100 ERG or more when the list
was generated (`src/tokenlist.json`, `npm run tokens` to refresh), plus an "other token" entry for any token id.

The page reads from a public explorer, builds transactions in your browser with [Fleet](https://fleet-sdk.github.io/docs/),
and hands them to an EIP-12 wallet ([Nautilus](https://github.com/nautls/nautilus-wallet), SAFEW) to sign and submit.
Your keys stay in your wallet. Before every wallet prompt the page states, in words, what it is about to ask you to
sign (the amounts and the fee), on the status line under the tabs and in the log.

## What a trade costs

|                                 | FreeDEX                                   | the order-box route most front ends use                                       |
| ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| miner fee                       | 0.001 ERG, the network minimum, once      | one for your order transaction and one for the execution transaction          |
| pool fee to liquidity providers | the pool's own (0.3% to 1%, shown)        | the same                                                                      |
| executor fee                    | none: your wallet submits the swap itself | paid to the bot that executes your order box (the order contract reserves it) |
| interface fee                   | none                                      | some front ends add one                                                       |

So a FreeDEX swap costs the pool's fee plus 0.001 ERG. Nothing else, and nothing to anyone running the page. The
other column describes the proxy-order design (an order box executed by an off-chain bot), not any one site's
numbers. Where a protocol's own contract carries a fee (SigmaFi's 0.5% to its developer, the SigmaUSD bank's 2%),
the page shows it; it adds none of its own anywhere. A program's executor fee is the owner's choice, paid per leg
to whoever runs it; the page adds none of its own there either.

## Use it

Open the live page with Nautilus installed, connect, and trade. Or sign from your phone: choose "sign with your
phone" in the header, enter your mainnet address once (it stays in this browser), and the page reads your boxes and
balances from the explorer. Each transaction is then reduced in the browser (sigma-rust's WASM binding, fetched only
on this path) and shown as a QR code and an `ergopay:` link holding the whole reduced transaction, EIP-20's static
mode: scan it with the Ergo mobile wallet (Terminus on iOS), check it there, sign; the wallet submits and the page
watches the explorer for the id. No server is involved. A transaction too large for a QR code (above 2,800
characters, which takes a dozen or more inputs) is refused with a note to consolidate boxes first. Or run it yourself:

```
npm ci
npm test          # the builders against the real contracts on Fleet's mock chain, the property suites, the page in happy-dom
npm run lint      # Prettier and ESLint, as CI runs them
npm run dev       # http://localhost:5173
npm run build     # dist/, static files for any host
npx playwright test   # the built page in Chromium (after npm run build and npx playwright install chromium)
```

`VITE_EXPLORER` selects another explorer API (`VITE_EXPLORER=https://api.ergo.aap.cornell.edu npm run build`). The
header's explorer menu does the same at runtime. A request that fails (a network error, a timeout after 15 s, a 5xx
or a 429) is retried on the same backend after 1 s, 2 s and 4 s before the next backend is tried; while that
happens every tab says "explorer unavailable, retrying" in place of its listing, the header line names the try in
progress, and a listing that failed shows a retry button. A line beside the menu says when the page is reading
from the second backend because the first did not answer.

## Host it yourself

Fork this repository, set Pages to "GitHub Actions" in the repository settings, and push to `main`. One workflow
run (`.github/workflows/pages.yml`) tests, builds and publishes `dist/`. Any static host works the same way with the
contents of `dist/`.

## What is where

- `src/protocols/<name>/`: one directory per protocol, the builders with their mock-chain tests beside them. Pure
  functions, no DOM, no network.
  - `ergodex/amm.ts`: pool quotes, price impact, and the direct swap, deposit and redeem builders, ERG pools and
    token-to-token pools.
  - `machina/orders.ts`: the limit-order builders (`buildCreate`, `buildFill`, `buildClose`) and `describe` for
    display; `machina/machina-arb.ts`: the keyless take of an order priced across its pool.
  - `babel/babel.ts`: EIP-31 Babel bids, the taker's fill and the keyless take.
  - `sigmausd/bank.ts`, `sigmafi/bonds.ts`, `tokenjay/escrow.ts`: the SigmaUSD bank, SigmaFi bonds and TokenJay
    escrow on their deployed contracts.
  - `clock/clock.ts`: the clocked box's two sides (buy and sell) and their builders (create for each side with the
    rent and length checks, the keyless leg and cancel for both); `option/option.ts`: the call and the put.
- `src/registry.json`, `src/registry.ts`: the contract registry, the one place every tree and template hash the
  page builds against lives, with each contract's source, licence and the date its hash was last matched against a
  mainnet box; `test/hashes.test.ts` checks every entry and recompiles `contracts/*.es` against it;
  `scripts/registry-check.ts` asks the explorer for a box per entry.
- `contracts/`: this project's own ErgoScript (`Clock.es`, `ClockSell.es`, `Call.es`, `Put.es`), compiled by
  `scripts/compile-clock.ts` and `scripts/compile-option.ts`.
- `docs/invariants/`: what each builder checks, what it leaves to the contract, and the test that proves each
  refusal, one file per domain (below).
- `src/explorer.ts`: height, token metadata, pools and open orders by ErgoTree template hash, with amounts parsed as
  exact integers (every pool's LP token amount is past what a JavaScript number holds); the retry and failover.
- `src/upkeep.ts`: the keyless job runner (Babel bids, Machina orders, the `clock-legs` job) and the two jobs that
  need the wallet.
- `src/wallet.ts`, `src/ergopay.ts`: EIP-12 connect, balances, UTXOs, sign and submit; the phone path.
- `src/units.ts`: decimal text to smallest units and back, exact.
- `src/ui/`: one module per tab (`swap.ts`, `orders.ts`, `pool.ts`, `bank.ts`, `bonds.ts`, `escrow.ts`,
  `programs.ts`, `options.ts`), the header (`header.ts`, `wallet.ts`), the upkeep timer (`upkeep.ts`), the shared
  state with its subscriptions (`store.ts`), the listing states (`listing.ts`) and the DOM helpers (`dom.ts`).
  Chain-sourced strings only ever become text nodes; nothing writes `innerHTML`.
- `src/main.ts`, `index.html`: the tab switcher and the boot sequence; the page.
- `test/`: the cross-cutting tests (the registry, units, sizing, the keyless id, the explorer's parser and retries,
  the phone path, the upkeep finders); `test/properties/` the property suites (`fast-check`, the mock chain as the
  oracle); `test/ui/` renders `index.html` in happy-dom over a stubbed explorer and wallet, drives the tabs, and
  runs `axe-core` over each; `test/browser/` the one Playwright test of the built page in Chromium.

## Invariants

What each builder checks and throws, which values the user sets and which come from the chain, the arithmetic and
its rounding direction against the contract line it mirrors, what the contract refuses that the builder does not
pre-check, the test that proves each refusal, and the limits: [pools](docs/invariants/pools.md),
[orders](docs/invariants/orders.md) (Machina and Babel), [bank](docs/invariants/bank.md),
[bonds](docs/invariants/bonds.md), [escrow](docs/invariants/escrow.md), [clock](docs/invariants/clock.md),
[option](docs/invariants/option.md), [upkeep](docs/invariants/upkeep.md), [signing](docs/invariants/signing.md).

## Units and limits

- Pool swaps: the quote is the pool's constant-product rule with its fee numerator, rounded against you, the same
  arithmetic the pool script checks. The pool is re-read right before the transaction is built.
- Limit orders: the contract's price is an integer in nanoERG per smallest token unit. The page shows ERG per whole
  token and refuses a price it would have to round. Orders are labelled by what the taker does, as the contract does.
- Not yet: token-to-token limit orders, grid orders, multi-hop swaps in one go,
  Duckpools borrowing, options with a strike in a token (a SigUSD-denominated put).
- Programs: the price cap or floor is an integer in nanoERG per smallest token unit, so a bound below one nanoERG
  per unit cannot be expressed. An executor may shorten one interval by at most 4 blocks (`SLACK`); intervals of a
  few blocks are a test setting. A buy program holds no rent reserve (a rent claim after four years idle would
  shorten it, or consume a box smaller than the fee, about 0.83 ERG for its 666 bytes); a sell program holds one
  rent fee for its bytes (about 0.89 ERG for 714 bytes), held, not spent, and returned with the last leg. A leg
  built while the box is in the mempool is still a block or two early: the clock starts at the first block the box
  can be mined in, not the block it lands in.
- Options: the strike is an integer in nanoERG per smallest token unit, as a limit order's price is; the page shows
  ERG per token and refuses a strike it would have to round. The expiry is a block height; a buy or exercise is
  built only while the wallet's height is below it (the node checks the next block), a reclaim once it has reached
  it. A premium below 0.0001 ERG cannot be paid in a box. A call box holds one rent fee for its bytes (about 0.56
  ERG for 450 bytes) because a token box that cannot pay rent is consumed whole; the expiry must be within one rent
  period (1,051,200 blocks).
- A deposit needs tokens at the pool's ratio; the page computes the token amount from the ERG amount and tells you
  if the wallet is short before anything is signed.

## Compatibility

Only what has been run is listed; see `CHANGELOG.md` for when.

- Wallets: Nautilus and SAFEW through EIP-12 (the dApp connector; the page is tested against a stubbed connector
  and the builders' transactions were signed through the project's own guarded signer on mainnet); the Ergo mobile
  wallet and Terminus through ErgoPay in its static mode (the page's QR code; a static code of any scannable
  length goes straight to the wallet's signing screen by its source, and the scan itself is the person's check,
  not yet recorded here); Satergo untested.
- Explorers: `api.ergoplatform.com` and `api.ergo.aap.cornell.edu`, both serving `/api/v1` with cross-origin
  reads; either may be chosen in the header, and the page fails over between them.
- Node: the contracts were checked on Fleet's mock chain (`sigmastate-js`, the node's own interpreter compiled to
  JavaScript) and on mainnet through the explorer's mempool (the transactions listed below); no node version is
  recorded beyond that.
- Browsers: the WASM path (the phone's reduction) has run in Chromium 156 (Playwright's headless build, Linux) on
  every pull request; no other browser is recorded until the person confirms one.

## Status

Built 2026-10-29 in [skunkyard](https://github.com/cafebedouin/skunkyard) (SK-063). Every builder has run on
mainnet through a test wallet with pocket change; the transaction ids are listed in the section below. Still use
pocket change: this is days old. Version `v0.1.0` is the hardening pass of 2026-10-29 (`CHANGELOG.md`); security
reports go through `SECURITY.md`.

### Mainnet transactions from these builders

| what                                                                                                                                                                                                                         | transaction                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fill a stranger's limit order (buy 1.00 FAKU)                                                                                                                                                                                | `b5de600959b49f8485d1c652bc3e71a50ccb063dd9512d60b3ee6dbf9fa386e2`                                                                                                                                                                                                             |
| place a limit order (sell 1.00 FAKU)                                                                                                                                                                                         | `2abc992b14f9be5a904a8b850aa8faffdac90cb8ef82c6c29954f0a55029adf2`                                                                                                                                                                                                             |
| partial fill of that order (40 units)                                                                                                                                                                                        | `6ebf30c18f064ec516715ad67d6b0fcbd9a200b841c70489e268c44c54db3859`                                                                                                                                                                                                             |
| close it (60 units back)                                                                                                                                                                                                     | `95a939cb823e49e4d4f4dd01d44a391a87eb78bb12c363e6f7ae8efdaf9bb956`                                                                                                                                                                                                             |
| pool swap, 0.01 ERG to rsADA                                                                                                                                                                                                 | `ea0a7dfeb6964df57c5fcf86a4734c44572f58547aedad36ddbeb38e1c3ba9d4`                                                                                                                                                                                                             |
| pool swap back, rsADA to ERG                                                                                                                                                                                                 | `7303dce957bf31a2d4d8518a8a639b3b464c648a7304bd905044aafac163eea8`                                                                                                                                                                                                             |
| add liquidity, 0.003 ERG + FAKU                                                                                                                                                                                              | `5eaa12e353aa67277823793ee7f3892193fe50fd93d7e26c3a8c8528a0747b17`                                                                                                                                                                                                             |
| remove liquidity, the LP tokens back                                                                                                                                                                                         | `fd30f0e688047b91dc3461ee322ae9dbcb65bbaf4c3ebdd1196cc80742e0f4aa`                                                                                                                                                                                                             |
| token-to-token swap, FAKU to CYPX                                                                                                                                                                                            | `643be27f7a2f28a81d88a3297a8107eff790bd05fda26af21249acd7558eb2c5`                                                                                                                                                                                                             |
| keyless upkeep: a live Babel bid taken through the explorer, no signature                                                                                                                                                    | `43f5fe4560ad967619c8dc9bcdcc23db641f715f8c828fd82f37d75c2ec214cb`                                                                                                                                                                                                             |
| escrow: offer 10 FAKU to a named buyer, then the buyer takes it                                                                                                                                                              | `d9d8b0af26deb343b527f5dc8ef47655b96c67a0c75f09568bf851f904b34371`, `10017e3b141bc114c73e9d9d934213a97bc193cd7c050f0b455e24da53c22a95`                                                                                                                                         |
| bonds: request a loan, fund it, repay it before maturity                                                                                                                                                                     | `887902b55bea59e86cdab33bebd830d7f85f098a5932759dba3cf11152e9814f`, `ae235887046f36450bbfe25974b280660a14001949fb3693510e655a0e479635`, `24a2be9d647edc06158e88ac8a00157192b8674cda149fc471277a8d36087c46`                                                                     |
| programs: create a clocked program (3 legs of 0.01 ERG, FAKU), then its three legs executed keylessly by the Node runner, the last closing the box                                                                           | `3d509bf569271685d00e97dbd89299b125cf25e45761c18869475c290c2f9ae4`, `95082ff30496dcae33049adb889c47962c0e3efab534b2c358d1f5fdc4e3ca8b`, `44c970a3b7cc7e3fec830068249f6eafdb19709303931feca3c2009842974833`, `3abd3594996ec91c0256a7187a70a7bbb3568e11f857e73fd2f66b6efcca1c15` |
| programs, sell side: create a tranche sale (9 FAKU units in 3 legs of 3), then its three legs executed keylessly by the Node runner, the last closing the box and returning the rent reserve                                 | `8ffed74928c91f0b41e366acb5033aac4864ca7d448cdb02504f742df173c09d`, `ffedaeacf9539181e60ef1d66a185935b9a07dc22139720b36389a9acf153ba9`, `b730af2abf35f4869389c6c3439533d99a7743d32b681a4f129efa805d24eedf`, `cec63af0775b67ff441691b1a3134c05480dc7004efed2b01981140c1706247b` |
| programs, buy side under the side-dependent rent rule: the same 3-leg program with 0.0345 ERG locked instead of 0.87325, its three legs keyless                                                                              | `6efce60b29f36b5050bc8a590460114662c08a37ca765c3dad99ac2f8c1c8211`, `e57b396e2af4d7e598d82f068356d85c2e5c756d82c90c1a317ac52d793b534d`, `fd7782d1d5ae46bb7adb7d73e5adb85e7ed47b503e34a6f1baa8afd436f90241`, `1b40188cdb74c6ff984ee380c8223ebe9fbd6a55ae36edcfd517d357d7628db5` |
| options: write a covered call on 9 FAKU units (0.71 ERG rent reserve held), buy it (keyless path, the premium to the writer), exercise it under the buyer's key (strike plus reserve to the writer, the tokens to the buyer) | `88390a99f8cbad33760b6be3b399455bcf52bd0fb3d93b174e8f330e1a415e5f`, `00b09b3d9c705b99a48dc332d4eb9ecebbc55fb2d46919f396080de296be2d41`, `9e39054580f1a66a819c4283c1f6575c785638b151fc62810285a4de9e5da64b`                                                                     |
| options: write a cash-secured put on 320 FAKU units (0.01 ERG collateral), buy it, exercise it (the tokens to the writer, the collateral to the buyer)                                                                       | `cf844235178402b610bf6e7c85df615c5ebd1742ecd3c43cc0ccf280484c9c08`, `ce01d9bf4e211f8e483eab1c3a2ec91b8a5ed2da3f63f5afa049058be5910ebe`, `fadce9ab848c87e5d4b2af5e0773b22047d04e544415312231337cc65ef4513f`                                                                     |
| options: write a second call and a second put, leave them unsold past their expiry, reclaim both under the writer's key                                                                                                      | `5cece0d9c340ec4f38e68fb44da9e9c4275a9fa587c637cc799c15f78aeb5460`, `23512ea58c092ba6a4ba9197df95cfb31dc6f201b7000f2658c71e336f505a8f`, `1d642d7058ce7bcfb2841569d699fd502e76537796d82e14112fba29f4ad1586`, `11881457098d42e609b96b66d862b18dcfe9f925cef51bbad02cdb77bbda6299` |
| bank: mint 100 SigRSV, redeem 0.05 SigUSD                                                                                                                                                                                    | `c9feee3d5b22a692cfe3c4c50f28960089b2852d8350a029f8079e50705a3c6a`, `96478f1bb4f2e36891ff16e126c9f2ee675d6f49ae46e641237c1b1f0a0a29d0`                                                                                                                                         |

## Review of 2026-10-30

Two independent reviews found a stored XSS (token names from the chain reached `innerHTML`) and a slippage guard
that could not fire (the minimum was derived from the same pool it was checked against). Both are fixed: every
chain-sourced string is now a text node, a Content-Security-Policy header allows no external script, and the
swap's minimum is the one from the quote the user saw, so a pool that moved past it refuses to build. Also from the
reviews: explorer failover with timeouts and a short listing cache, a runtime explorer choice in the header, pinned
template hashes, tests for units, sizing against brute force, and the keyless id, and a pull-request CI trigger.
The two deferred items followed: the page is one module per tab over a small store (`src/ui/`), and `test/ui/`
drives the rendered page in happy-dom (routes, quotes and the stale-quote refusal, deposits from either side, the
bank's "allowed" line, order grouping, the positions sections, the fallback line, the upkeep job; and a check that
no element carries an inline handler). Prettier and ESLint run in CI before the tests.

A second list, 2026-10-29, became the hardening pass tagged `v0.1.0`: the invariants written down, property tests
(which found that the pool script cannot evaluate a swap whose input times the fee numerator passes a Long, now
refused by the builder), the contract registry, scanning on a budget (`npm audit`, CodeQL weekly, Dependabot
monthly), one browser test under the CSP, explorer retries with a visible state, and the accessibility pass.

## Licence

CC0 1.0 Universal: this project's own code is dedicated to the public domain, the same dedication skunkyard uses. The
SigmaFi-derived files keep their MIT notice; see `THIRD-PARTY-NOTICES.md`.
