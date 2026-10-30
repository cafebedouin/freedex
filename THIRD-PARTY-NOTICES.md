# Third-party notices

FreeDEX's own code is dedicated to the public domain under CC0 1.0 (see `LICENSE`). The following parts are derived
from, or carry, other people's work, and their notices travel with them.

## SigmaFi (MIT)

`src/protocols/sigmafi/bonds.ts` is a port of the transaction builders in `src/offchain/plugins.ts` of
https://github.com/capt-nemo429/sigmafi-ui, and the `sigmafi-*` entries of `src/registry.json` hold the deployed
contract bytes extracted from that file (`scripts/sigmafi-constants.mjs`, commit `309c1ac`). That module and those
entries are offered under CC0 to the extent of this project's contribution and remain subject to the original
licence for what they derive:

    MIT License

    Copyright (c) 2022 capt-nemo429

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Deployed contracts read as facts on chain

The page builds against contracts as deployed: the ErgoDEX v1 pools (https://github.com/spectrum-finance/ergo-dex,
CC0 1.0), the EIP-31 Babel fee contract (Ergo EIPs, CC0), the SigmaUSD bank (the AgeUSD protocol) and TokenJay's
escrow (its script is published at https://tokenjay.app/escrow.html with no stated licence; only the deployed
ErgoTree bytes are used here, with builders written from reading the script). The contract bytes themselves are
copied as they appear on the public ledger.

## Dependencies

Fleet SDK and its AgeUSD plugin, and `@nautls/machinafi-sdk` (Machina Finance), are MIT-licensed npm packages used
as dependencies and not copied into this repository.
