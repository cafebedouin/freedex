// Find token-to-token pools: start from boxes holding SigRSV, keep the ones shaped like a T2T pool
// (NFT, LP near 2^63, token X, token Y; R4 fee), hash their template, then list every pool under it.
import { ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import { parseExact } from "../src/explorer.ts";
const SIGRSV = "003bd19d0187117f130b62e1bcab0939929ff5c7709f843c5c4dd158949285d0";
const EXP = "https://api.ergoplatform.com/api/v1";
const get = async (u: string, init?: RequestInit) => parseExact(await (await fetch(u, init)).text()) as any;
// the explorer pages at 100: walk the SigRSV boxes until a T2T-shaped one appears
const cands: any[] = [];
let total = 0;
for (let offset = 0; offset < 2000 && cands.length === 0; offset += 100) {
  const r = await get(`${EXP}/boxes/unspent/byTokenId/${SIGRSV}?limit=100&offset=${offset}`);
  total = r.total;
  cands.push(...r.items.filter((b: any) => b.assets.length === 4 && BigInt(b.assets[1].amount) > 9_000_000_000_000_000_000n));
  if (r.items.length < 100) break;
}
console.log("SigRSV boxes:", total, "; first T2T-shaped found:", cands.length);
const trees = new Map<string, number>();
for (const b of cands) trees.set(b.ergoTree, (trees.get(b.ergoTree) ?? 0) + 1);
for (const [tree, n] of trees) {
  const tpl = new ErgoTree(tree).template;
  const h = hex.encode(sha256(tpl));
  const all = await get(`${EXP}/boxes/unspent/search?limit=500`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ergoTreeTemplateHash: h }) });
  const pools = all.items.filter((b: any) => b.assets.length === 4).map((b: any) => ({ id: b.boxId.slice(0, 10), x: b.assets[2].name, xr: BigInt(b.assets[2].amount), y: b.assets[3].name, yr: BigInt(b.assets[3].amount), fee: b.additionalRegisters.R4?.renderedValue, erg: BigInt(b.value) }));
  console.log(`tree ${tree.length / 2} B, template sha256 ${h}: ${n} SigRSV pools, ${all.total} boxes under the template, ${pools.length} with 4 tokens`);
  for (const p of pools.slice(0, 12)) console.log(" ", p.id, p.x, p.xr.toString(), "/", p.y, p.yr.toString(), "fee", p.fee, "erg", p.erg.toString());
}
