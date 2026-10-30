// List the ErgoDEX v1 ERG pools on mainnet by the template hash the page uses. node scripts/pools.ts
import { ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import { POOL_TREE, describePool } from "../src/protocols/ergodex/amm.ts";
import { Explorer, POOL_TEMPLATE_SHA256 } from "../src/explorer.ts";
console.log(
  "tree bytes",
  POOL_TREE.length / 2,
  "template sha256",
  hex.encode(sha256(new ErgoTree(POOL_TREE).template)),
  "pinned",
  POOL_TEMPLATE_SHA256,
);
const pools = await new Explorer(process.env.VITE_EXPLORER).pools(500);
console.log("pools:", pools.length, "; identical tree:", pools.filter((p) => p.box.ergoTree === POOL_TREE).length);
for (const p of pools.sort((a, b) => (b.box.value > a.box.value ? 1 : -1)).slice(0, 15)) {
  const v = describePool(p.box);
  console.log(
    v.boxId.slice(0, 10),
    String(Number(v.x) / 1e9).padStart(12),
    "ERG",
    (p.tokenName || v.tokenId.slice(0, 8)).padEnd(12),
    "fee",
    v.feeNum,
  );
}
