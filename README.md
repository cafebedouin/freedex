# FreeDEX for Ergo

A decentralized exchange front end you can host yourself: static files, no server, no keys in the page, no fee of
its own.

Live: https://cafebedouin.github.io/freedex/

The name follows the BSD convention, and the adjective means what Stallman meant: free as in freedom, and also as in
beer. Free to run, free to fork, free of anyone's server, and free of interface fees.

## What it does

- **Swap** on [ErgoDEX v1](https://github.com/spectrum-finance/ergo-dex) ERG-to-token pools (the pools Spectrum and
  Mew trade on), straight against the pool box in one transaction. No order box, no off-chain executor, no interface
  fee. The page quotes from the pool's own rule, shows the price impact, and refuses to build if the pool has moved
  past your slippage tolerance.
- **Limit orders** on [Machina Finance](https://github.com/machinafi/sdk): place one, fill one, close your own.
  Open orders are grouped by token, best price first on each side.
- **Pool**: add or remove liquidity on the same pools, straight to the pool box by its own rule. LP tokens are plain
  tokens in your wallet.

The swap and pool token lists are a static whitelist of tokens whose deepest pool held 100 ERG or more when the list
was generated (`src/tokenlist.json`, `npm run tokens` to refresh), plus an "other token" entry for any token id.

The page reads from a public explorer, builds transactions in your browser with [Fleet](https://fleet-sdk.github.io/docs/),
and hands them to an EIP-12 wallet ([Nautilus](https://github.com/nautls/nautilus-wallet), SAFEW) to sign and submit.
Your keys stay in your wallet.

## What a trade costs

| | FreeDEX | the order-box route most front ends use |
|---|---|---|
| miner fee | 0.001 ERG, the network minimum, once | one for your order transaction and one for the execution transaction |
| pool fee to liquidity providers | the pool's own (0.3% to 1%, shown) | the same |
| executor fee | none: your wallet submits the swap itself | paid to the bot that executes your order box (the order contract reserves it) |
| interface fee | none | some front ends add one |

So a FreeDEX swap costs the pool's fee plus 0.001 ERG. Nothing else, and nothing to anyone running the page. The
other column describes the proxy-order design (an order box executed by an off-chain bot), not any one site's
numbers.

## Use it

Open the live page with Nautilus installed, connect, and trade. Or run it yourself:

```
npm ci
npm test          # the builders against the real contracts on Fleet's mock chain
npm run dev       # http://localhost:5173
npm run build     # dist/, static files for any host
```

`VITE_EXPLORER` selects another explorer API (`VITE_EXPLORER=https://api.ergo.aap.cornell.edu npm run build`).

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
- `src/wallet.ts`: EIP-12 connect, balances, UTXOs, sign and submit.
- `src/units.ts`: decimal text to smallest units and back, exact.
- `src/main.ts`, `index.html`: the page.
- `test/`: mock-chain tests for both contracts (fills, refusals, a slippage guard) and the parser, with a captured
  pool box.

## Units and limits

- Pool swaps: the quote is the pool's constant-product rule with its fee numerator, rounded against you, the same
  arithmetic the pool script checks. The pool is re-read right before the transaction is built.
- Limit orders: the contract's price is an integer in nanoERG per smallest token unit. The page shows ERG per whole
  token and refuses a price it would have to round. Orders are labelled by what the taker does, as the contract does.
- Not yet: token-to-token pools and orders, grid orders, a mobile (ErgoPay) signing path.
- A deposit needs tokens at the pool's ratio; the page computes the token amount from the ERG amount and tells you
  if the wallet is short before anything is signed.

## Status

Built 2026-10-29 in [skunkyard](https://github.com/cafebedouin/skunkyard) (SK-063). Every builder has run on
mainnet through a test wallet with pocket change; the transaction ids are listed in the section below. Still use
pocket change: this is days old.

### Mainnet transactions from these builders

| what | transaction |
|---|---|
| fill a stranger's limit order (buy 1.00 FAKU) | `b5de600959b49f8485d1c652bc3e71a50ccb063dd9512d60b3ee6dbf9fa386e2` |
| place a limit order (sell 1.00 FAKU) | `2abc992b14f9be5a904a8b850aa8faffdac90cb8ef82c6c29954f0a55029adf2` |
| partial fill of that order (40 units) | `6ebf30c18f064ec516715ad67d6b0fcbd9a200b841c70489e268c44c54db3859` |
| close it (60 units back) | `95a939cb823e49e4d4f4dd01d44a391a87eb78bb12c363e6f7ae8efdaf9bb956` |
| pool swap, 0.01 ERG to rsADA | `ea0a7dfeb6964df57c5fcf86a4734c44572f58547aedad36ddbeb38e1c3ba9d4` |
| pool swap back, rsADA to ERG | `7303dce957bf31a2d4d8518a8a639b3b464c648a7304bd905044aafac163eea8` |
| add liquidity, 0.003 ERG + FAKU | `5eaa12e353aa67277823793ee7f3892193fe50fd93d7e26c3a8c8528a0747b17` |
| remove liquidity, the LP tokens back | `fd30f0e688047b91dc3461ee322ae9dbcb65bbaf4c3ebdd1196cc80742e0f4aa` |

## Licence

MIT.
