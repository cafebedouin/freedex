# Bank: the SigmaUSD bank through Fleet's AgeUSD plugin

Module: `src/protocols/sigmausd/bank.ts` (`loadBank`, `mintQuote`, `redeemQuote`, `buildMint`, `buildRedeem`).
Registry: `sigmausd-bank` (`246e14059ac2`), `sigmausd-oracle` (`19e4db356244`, a data input). Tests:
`src/protocols/sigmausd/bank.test.ts`.

The builders are `@fleet-sdk/ageusd-plugin` 0.1.23 (`node_modules/@fleet-sdk/ageusd-plugin/dist/index.mjs`); the
page passes no implementor fee, so only the bank's own fee applies. The plugin's `SIGMA_USD_PARAMETERS.contract` is
byte-equal to the live bank box's tree in the registry (722 bytes; checked 2026-10-29, `node -e` in the session).
The reference contract quoted below is `ageusd-smart-contracts/v0.4/AgeUSD.scala` of `Emurgo/age-usd` at commit
`e810b19` (MIT); that it is the exact source of the deployed bytes is [UNVERIFIED] (not recompiled here).
Constants there: `feePercent = 2`, `minReserveRatioPercent = 400`, `defaultMaxReserveRatioPercent = 800`,
`minStorageRent = 10000000L`, `rcDefaultPrice = 1000000` (lines 13-25).

## `loadBank`

1. Throws `bank or oracle box not found` (`bank.ts:22`) when either NFT has no unspent box.
2. Everything from the chain: the bank box by `BANK_NFT`, the oracle box by `ORACLE_NFT` (`explorer.byToken`, not
   cached); re-read right before every build at `src/ui/bank.ts`.
3. The plugin reads R4 (SigUSD in circulation), R5 (SigRSV in circulation), the three tokens, and the oracle's R4
   divided by `10 ** decimals` as nanoERG per cent (`index.mjs:32`); the contract reads
   `val rate = rateBox.R4[Long].get / 100` (AgeUSD.scala:43).
4. n/a.
5. `bank.test.ts` seeds the bank at a 667% ratio and asserts `reserveRatio` between 400 and 800.
6. The oracle box is a data input; a transaction built against an oracle box that is replaced before mining is
   invalid, not mispriced.

## `mintQuote` and `redeemQuote`

1. Nothing thrown; `allowed` carries the plugin's `canMint` / `canRedeem` (`bank.ts:36`, `:44`).
2. The user sets the coin (SigUSD, 2 decimals; SigRSV, 0) and the amount; everything else from the two boxes.
3. Mint cost (`getMintingCostFor(amount, coin, "total", FEE)`, `index.mjs:192-201`):
   `base = price * amount`; `cost = base + percent(base, 2) + FEE` where `percent(v, 2) = v * 2 / 100`
   (`@fleet-sdk/common`, `index.mjs:223-225`, integer division, rounded down). The contract:
   `val fee = brDeltaExpected * $feePercent / 100` and `brDeltaExpectedWithFee = brDeltaExpected + actualFee`
   (AgeUSD.scala:127-131). Redeem (`getRedeemingAmountFor`, `index.mjs:203-213`): `base - percent(base, 2) - FEE`,
   floored at 0. The price: SigUSD `min(oracleRate, liabilities / circulatingStable)` (`index.mjs:78-80`;
   contract `scNominalPrice = min(rate, liableRate)`, line 117-118), SigRSV `equity / circulatingReserve` or the
   default 1,000,000 nanoERG when there is no equity or at most one coin (`index.mjs:82-88`; contract lines
   120-123). All integer division, rounded down, the same order of operations as the contract.
   `reserveRatioAfter` (`getReserveRatioFor`, `index.mjs:162-177`): `baseReserves * 100 / circulatingStable /
oracleRate`, which equals the contract's `bcReserveOut * 100 / bcReserveNeededOut` (line 102) because
   `floor(floor(a / b) / c) = floor(a / (b * c))` for positive integers.
   `allowed`: mint SigUSD when the ratio after is `>= 400`, mint SigRSV when it is `<= 800`; redeem SigUSD when
   `amount <= circulating` (no ratio condition), redeem SigRSV when the ratio after is `>= 400`
   (`index.mjs:153-161`); the contract's `validReserveRatio` block (lines 104-114) has the same four branches.
4. The contract's `maxReserveRatioPercent` is infinite until `coolingOffHeight` (line 100); the plugin applies 800
   unconditionally. Mainnet is past that height, so no live difference [UNVERIFIED which height it was].
5. `bank.test.ts` "mints 10 SigUSD at the oracle price plus the 2% protocol fee, then redeems them" (the quoted
   cost equals the balance change; the redeem returns less than the mint cost).
6. The quote includes the miner fee (`"total"`), so "You pay" on the Bank tab is the whole debit.

## `buildMint` and `buildRedeem`

1. The plugin asserts `Unable to mint more than ${available} ${coin} coins.` / `Unable to redeem more than ...`
   when `canMint` / `canRedeem` is false (`index.mjs:267-271`, `:282`, `:293-296`); the page disables the button
   first (`src/ui/bank.ts`).
2. The user's coin and amount; the bank and oracle re-read at `src/ui/bank.ts` right before the build.
3. The plugin (`index.mjs:273-359`): the bank successor at output 0 with the value moved by the base amount plus
   the fee, the token amounts and R4/R5 moved by the amount; the recipient's box at output 1 (`SAFE_MIN_BOX_VALUE`
   plus the coins on a mint; the redeem proceeds less the miner fee on a redeem) carrying R4 = the circulation
   delta and R5 = the nanoERG delta; the oracle as data input 0; the miner fee set to `FEE`. The page adds no
   implementor output (`implementorAddress` unset, `:354`).
4. The contract also checks the bank keeps at least `minStorageRent` (line 88), the oracle data input's NFT, the
   token ids and the register updates; the builder relies on the plugin for all of them.
5. `bank.test.ts` "mints 10 SigUSD at the oracle price plus the 2% protocol fee, then redeems them" (both
   transactions accepted by the deployed tree on the mock chain). There is no mock-chain case of a refused mint
   (a ratio outside the band) [gap].
6. One bank box: a mint mined after another mint spends the input and is invalid; the page re-reads the bank
   before building. The mock chain evaluates at `height + 1`; the contract's only height term is
   `coolingOffHeight`, long past.

Properties: none; the bank's arithmetic is the plugin's and is pinned by its version.
