// List the token-to-token pools on mainnet. node scripts/t2t-pools.ts
import { T2T_POOL_TREE, describeT2TPool } from "../src/amm.ts";
import { Explorer } from "../src/explorer.ts";
const pools = await new Explorer(process.env.VITE_EXPLORER).t2tPools(500);
console.log("pools:", pools.length, "; identical tree:", pools.filter((p) => p.box.ergoTree === T2T_POOL_TREE).length);
for (const p of pools.slice(0, 20)) {
  const v = describeT2TPool(p.box);
  console.log(v.boxId.slice(0, 10), `${p.xName || v.xId.slice(0, 8)} ${v.x} / ${p.yName || v.yId.slice(0, 8)} ${v.y}`, "fee", v.feeNum);
}
