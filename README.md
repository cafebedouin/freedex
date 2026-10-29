# FreeDEX for Ergo

A decentralized exchange front end you can host yourself: static files, no server, no keys in the page.

Live: https://cafebedouin.github.io/freedex/

Today it covers [Machina Finance](https://github.com/machinafi/sdk) ERG-to-token limit orders on Ergo mainnet. The
page lists every open order from a public explorer, builds transactions in your browser with
[Fleet](https://fleet-sdk.github.io/docs/) and `@nautls/machinafi-sdk`, and hands them to an EIP-12 wallet
([Nautilus](https://github.com/nautls/nautilus-wallet), SAFEW) to sign and submit. Your keys stay in your wallet.

The name follows the BSD convention, and the adjective means what Stallman meant: free as in freedom, and also as in
beer. Free to run, free to fork, free of anyone's server.

## Use it

Open the live page with Nautilus installed, connect, and trade. Or run it yourself:

```
npm ci
npm test          # the builders against the real contract on Fleet's mock chain
npm run dev       # http://localhost:5173
npm run build     # dist/, static files for any host
```

`VITE_EXPLORER` selects another explorer API (`VITE_EXPLORER=https://api.ergo.aap.cornell.edu npm run build`).

## Host it yourself

Fork this repository, set Pages to "GitHub Actions" in the repository settings, and push to `main`. One workflow
run (`.github/workflows/pages.yml`) tests, builds and publishes `dist/`. Any static host works the same way with the
contents of `dist/`.

## What is where

- `src/orders.ts`: the three builders (`buildCreate`, `buildFill`, `buildClose`) and `describe` for display. Pure
  functions, no DOM, no network.
- `src/explorer.ts`: height, token metadata, open orders by ErgoTree template hash.
- `src/wallet.ts`: EIP-12 connect, UTXOs, sign and submit.
- `src/main.ts`, `index.html`: the page.
- `test/orders.test.ts`: mock-chain tests (create, partial and full fill, close, two refusals).
- `scripts/list-orders.ts`: read-only smoke test against mainnet; `scripts/template-hash.mjs`: how the template
  hash was computed.

## Units and limits

- The contract's price is an integer in nanoERG per smallest token unit. The page shows and takes ERG per whole
  token and converts with the token's decimals from the explorer. A price that is not a whole number of nanoERG per
  smallest unit is refused, not rounded.
- Orders are labelled by what the taker does ("buy tokens", "sell tokens"), as the contract and SDK do. The create
  form is labelled by what you, the owner, do.
- Token-to-token orders and grid orders are not supported yet.

## Status

Built 2026-10-29 as part of [skunkyard](https://github.com/cafebedouin/skunkyard) (SK-063). The builders pass on
the mock chain and parse every live mainnet order; the first mainnet transactions from the page are pending. Use
pocket change until they are recorded here.

## Licence

MIT.
