// The phone path's first check: reduce a transaction the page's builders produce, against mainnet state, in Node.
// A pool swap of 0.005 ERG from the given address into the deepest ERG pool, built exactly as the Swap tab builds
// it, reduced with sigma-rust's binding over the explorer's last ten headers; prints the sizes. Read-only: nothing
// is signed or submitted.
// Run: node scripts/reduce.ts [address]   (Node 23+ strips types; no build needed)
import { createRequire } from "node:module";
import { ErgoAddress } from "@fleet-sdk/core";
import { buildSwap, describePool, quote } from "../src/protocols/ergodex/amm.ts";
import { Explorer } from "../src/explorer.ts";
import { HEADERS_NEEDED, QR_MAX_CHARS, reduceTransaction, sizeGuard, toEip12Box } from "../src/ergopay.ts";
import type { ErgoLibModule } from "../src/ergopay.ts";

const require = createRequire(import.meta.url);
const lib = require("ergo-lib-wasm-nodejs") as ErgoLibModule;

const address = process.argv[2] ?? "9gnBiuBAy4GgGEk1MZQ5f7aWWuQnyGHNVVF4bvhHKWvecWTNcfc";
const user = ErgoAddress.fromBase58(address);
const explorer = new Explorer(process.env.VITE_EXPLORER);
explorer.onBaseChange = (b) => console.log(`explorer: reading from ${b}`);

const height = await explorer.height();
const headers = (await explorer.headers(HEADERS_NEEDED)) as { height: number; id: string }[];
console.log(
  `height ${height}; ${headers.length} headers from ${explorer.base}, ${headers[0].height} down to ${headers.at(-1)!.height}`,
);

const boxes = await explorer.unspentByAddress(address);
const inputs = boxes.map(toEip12Box);
const erg = boxes.reduce((s, b) => s + b.value, 0n);
console.log(`${address}: ${boxes.length} boxes, ${Number(erg) / 1e9} ERG`);

const pools = await explorer.pools();
const deepest = pools.reduce((a, b) => (b.box.value > a.box.value ? b : a));
const pool = describePool(deepest.box);
const amountIn = 5_000_000n;
const out = quote(pool, "erg-to-token", amountIn);
const minOut = (out * 99n) / 100n;
console.log(
  `pool ${deepest.tokenName} (${pool.nft.slice(0, 8)}…), ${Number(pool.x) / 1e9} ERG deep; 0.005 ERG pays ${out}`,
);

const tx = buildSwap({ height, inputs, user, poolBox: deepest.box, direction: "erg-to-token", amountIn, minOut });
const unsignedJson = JSON.stringify(tx);
const t0 = Date.now();
const r = reduceTransaction(lib, tx, headers);
const ms = Date.now() - t0;
console.log(
  `unsigned: ${tx.inputs.length} inputs, ${tx.dataInputs.length} data inputs, ${tx.outputs.length} outputs; EIP-12 JSON ${unsignedJson.length} bytes`,
);
console.log(`reduced: ${r.bytes.length} bytes in ${ms} ms; id ${r.txId}`);
console.log(
  `ergopay link: ${r.link.length} characters (limit ${QR_MAX_CHARS}); ${sizeGuard(r.link) ?? "fits a QR code"}`,
);
const back = lib.ReducedTransaction.sigma_parse_bytes(r.bytes);
console.log(`parses back: ${back.unsigned_tx().id().to_str() === r.txId ? "same id" : "DIFFERENT ID"}`);
