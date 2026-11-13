# TEMPORARY: ergo-lib-wasm 0.29.0 before its npm release

Replace with the npm release when 0.29.0 is published (`"ergo-lib-wasm-browser": "0.29.0"`,
`"ergo-lib-wasm-nodejs": "0.29.0"` in `package.json`, then delete this directory).

0.28.0, the release on npm, cannot read ErgoTree version 2 or 3 scripts: the tree's root expression fails to
parse (`NonConsumedBytes`), so any input under such a script cannot be reduced or signed. LithosDex's pool, vault,
provision and order contracts are version 3. These two packages are the WASM binding built from sigma-rust's
`develop` branch, which reads them.

| file | package | built from | `ergo_lib_wasm_bg.wasm` sha256 |
| --- | --- | --- | --- |
| `ergo-lib-wasm-browser-0.29.0.tgz` | `ergo-lib-wasm-browser@0.29.0` | sigma-rust `688511dff3e3436dfdd6bd368e3eeef6f67d59e9` | `4b7d597d8462e1c4bf4b96661699a6f3c2d18e1cd1a795a5178b4781d35b11b8` |
| `ergo-lib-wasm-nodejs-0.29.0.tgz` | `ergo-lib-wasm-nodejs@0.29.0` | sigma-rust `688511dff3e3436dfdd6bd368e3eeef6f67d59e9` | `a7d594885cac2dae6ffe7578e7294870697e74f8cb0d0d66c87ff43eea9bcba4` |

Both were built on a GitHub-hosted runner with the repository's own scripts (`npm run build-nodejs`,
`npm run build-browser`: `wasm-pack 0.14.0`, rustc 1.91.1, `WASM_BINDGEN_WEAKREF=1`, the browser build with the
`rest` feature). The browser tarball is the runner's `npm pack` output (tarball sha256
`ef9b3759c7660f1bbec1e015eff8fce070acc905b3b956566b072c255a7823bb`); the Node tarball was packed here from the
runner's `pkg-nodejs/` directory with `npm pack`, so only the hash of the `.wasm` inside it is the runner's.

Check: `tar xzf <tarball> -O package/ergo_lib_wasm_bg.wasm | sha256sum`.
