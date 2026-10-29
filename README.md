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
  address here, so it returns to them. Your own requests and bonds are listed first, before the market.
- **Escrow**: a token sale to one named buyer at an ERG price on TokenJay's deployed escrow contract. The contract
  demands a small fee box, which the page pays to the seller, so a sale costs the miner fee only. Your own escrows
  first, then every other open one on the contract.
- **Chain upkeep while you are here.** With a wallet connected, the page looks every few minutes for boxes anyone
  may act on for a bounty, builds those transactions with no signature and none of your funds, submits them through
  the explorer, and sends the bounty to your address. Today's jobs: Babel bids (EIP-31) priced above their token's
  pool, and Machina limit orders priced across the pool, either side. Default on, one checkbox to turn off. It never
  touches your own transaction, so a contended box costs you nothing but a log line. The same jobs run headless
  from Node (`scripts/upkeep-run.ts <address>`), which is the sidecar for anyone who wants to keep the chain tidy
  without a browser open. One more job needs your wallet: if a SigmaFi bond you lent on has matured, the page builds
  the transaction that hands you the collateral (the contract lets anyone do that; the miner fee comes from your
  change) and asks your wallet to sign it, once per bond.

The swap and pool token lists are a static whitelist of tokens whose deepest pool held 100 ERG or more when the list
was generated (`src/tokenlist.json`, `npm run tokens` to refresh), plus an "other token" entry for any token id.

The page reads from a public explorer, builds transactions in your browser with [Fleet](https://fleet-sdk.github.io/docs/),
and hands them to an EIP-12 wallet ([Nautilus](https://github.com/nautls/nautilus-wallet), SAFEW) to sign and submit.
Your keys stay in your wallet.

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
the page shows it; it adds none of its own anywhere.

## Use it

Open the live page with Nautilus installed, connect, and trade. Or run it yourself:

```
npm ci
npm test          # the builders against the real contracts on Fleet's mock chain, and the page in happy-dom
npm run lint      # Prettier and ESLint, as CI runs them
npm run dev       # http://localhost:5173
npm run build     # dist/, static files for any host
```

`VITE_EXPLORER` selects another explorer API (`VITE_EXPLORER=https://api.ergo.aap.cornell.edu npm run build`). The
header's explorer menu does the same at runtime, and a line beside it says when the page is reading from the second
backend because the first did not answer.

## Host it yourself

Fork this repository, set Pages to "GitHub Actions" in the repository settings, and push to `main`. One workflow
run (`.github/workflows/pages.yml`) tests, builds and publishes `dist/`. Any static host works the same way with the
contents of `dist/`.

## What is where

- `src/amm.ts`: pool quotes, price impact, and the direct swap, deposit and redeem builders. Pure functions, no DOM,
  no network.
- `src/orders.ts`: the limit-order builders (`buildCreate`, `buildFill`, `buildClose`) and `describe` for display.
- `src/explorer.ts`: height, token metadata, pools and open orders by ErgoTree template hash, with amounts parsed as
  exact integers (every pool's LP token amount is past what a JavaScript number holds).
- `src/bank.ts`, `src/bonds.ts`, `src/escrow.ts`: the SigmaUSD bank, SigmaFi bonds and TokenJay escrow on their
  deployed contracts; `src/sigmafi-contracts.json` holds SigmaFi's contract hex as extracted from its MIT source.
- `src/babel.ts`, `src/machina-arb.ts`, `src/upkeep.ts`: the keyless takes (sizing against the pool's rule, no
  signature) and the job runner.
- `src/wallet.ts`: EIP-12 connect, balances, UTXOs, sign and submit.
- `src/units.ts`: decimal text to smallest units and back, exact.
- `src/ui/`: one module per tab (`swap.ts`, `orders.ts`, `pool.ts`, `bank.ts`, `bonds.ts`, `escrow.ts`), the header
  (`header.ts`, `wallet.ts`), the upkeep timer (`upkeep.ts`), the shared state with its subscriptions (`store.ts`)
  and the DOM helpers (`dom.ts`). Chain-sourced strings only ever become text nodes; nothing writes `innerHTML`.
- `src/main.ts`, `index.html`: the tab switcher and the boot sequence; the page.
- `test/`: mock-chain tests for every builder (fills, refusals, a slippage guard) and the parser, with a captured
  pool box; `test/ui/` renders `index.html` in happy-dom over a stubbed explorer and wallet and drives the tabs.

## Units and limits

- Pool swaps: the quote is the pool's constant-product rule with its fee numerator, rounded against you, the same
  arithmetic the pool script checks. The pool is re-read right before the transaction is built.
- Limit orders: the contract's price is an integer in nanoERG per smallest token unit. The page shows ERG per whole
  token and refuses a price it would have to round. Orders are labelled by what the taker does, as the contract does.
- Not yet: token-to-token limit orders, grid orders, a mobile (ErgoPay) signing path, multi-hop swaps in one go,
  Duckpools borrowing, the clocked box (DCA, tranche sales) and the timed-escrow option, which are chartered.
- A deposit needs tokens at the pool's ratio; the page computes the token amount from the ERG amount and tells you
  if the wallet is short before anything is signed.

## Status

Built 2026-10-29 in [skunkyard](https://github.com/cafebedouin/skunkyard) (SK-063). Every builder has run on
mainnet through a test wallet with pocket change; the transaction ids are listed in the section below. Still use
pocket change: this is days old.

### Mainnet transactions from these builders

| what                                                                      | transaction                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fill a stranger's limit order (buy 1.00 FAKU)                             | `b5de600959b49f8485d1c652bc3e71a50ccb063dd9512d60b3ee6dbf9fa386e2`                                                                                                                                         |
| place a limit order (sell 1.00 FAKU)                                      | `2abc992b14f9be5a904a8b850aa8faffdac90cb8ef82c6c29954f0a55029adf2`                                                                                                                                         |
| partial fill of that order (40 units)                                     | `6ebf30c18f064ec516715ad67d6b0fcbd9a200b841c70489e268c44c54db3859`                                                                                                                                         |
| close it (60 units back)                                                  | `95a939cb823e49e4d4f4dd01d44a391a87eb78bb12c363e6f7ae8efdaf9bb956`                                                                                                                                         |
| pool swap, 0.01 ERG to rsADA                                              | `ea0a7dfeb6964df57c5fcf86a4734c44572f58547aedad36ddbeb38e1c3ba9d4`                                                                                                                                         |
| pool swap back, rsADA to ERG                                              | `7303dce957bf31a2d4d8518a8a639b3b464c648a7304bd905044aafac163eea8`                                                                                                                                         |
| add liquidity, 0.003 ERG + FAKU                                           | `5eaa12e353aa67277823793ee7f3892193fe50fd93d7e26c3a8c8528a0747b17`                                                                                                                                         |
| remove liquidity, the LP tokens back                                      | `fd30f0e688047b91dc3461ee322ae9dbcb65bbaf4c3ebdd1196cc80742e0f4aa`                                                                                                                                         |
| token-to-token swap, FAKU to CYPX                                         | `643be27f7a2f28a81d88a3297a8107eff790bd05fda26af21249acd7558eb2c5`                                                                                                                                         |
| keyless upkeep: a live Babel bid taken through the explorer, no signature | `43f5fe4560ad967619c8dc9bcdcc23db641f715f8c828fd82f37d75c2ec214cb`                                                                                                                                         |
| escrow: offer 10 FAKU to a named buyer, then the buyer takes it           | `d9d8b0af26deb343b527f5dc8ef47655b96c67a0c75f09568bf851f904b34371`, `10017e3b141bc114c73e9d9d934213a97bc193cd7c050f0b455e24da53c22a95`                                                                     |
| bonds: request a loan, fund it, repay it before maturity                  | `887902b55bea59e86cdab33bebd830d7f85f098a5932759dba3cf11152e9814f`, `ae235887046f36450bbfe25974b280660a14001949fb3693510e655a0e479635`, `24a2be9d647edc06158e88ac8a00157192b8674cda149fc471277a8d36087c46` |
| bank: mint 100 SigRSV, redeem 0.05 SigUSD                                 | `c9feee3d5b22a692cfe3c4c50f28960089b2852d8350a029f8079e50705a3c6a`, `96478f1bb4f2e36891ff16e126c9f2ee675d6f49ae46e641237c1b1f0a0a29d0`                                                                     |

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

## Licence

CC0 1.0 Universal: this project's own code is dedicated to the public domain, the same dedication skunkyard uses. The
SigmaFi-derived files keep their MIT notice; see `THIRD-PARTY-NOTICES.md`.
