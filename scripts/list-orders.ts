// Smoke test against mainnet: list open E2T limit orders through the page's own explorer client and describe().
// Run: node scripts/list-orders.ts   (Node 23+ strips types; no build needed)
import { Explorer } from "../src/explorer.ts";
import { capacity, describe } from "../src/orders.ts";

const explorer = new Explorer(process.env.VITE_EXPLORER);
const height = await explorer.height();
const boxes = await explorer.limitOrders(200);
let ok = 0, bad = 0;
const byToken = new Map<string, number>();
for (const b of boxes) {
  try {
    const v = describe(b);
    ok++;
    byToken.set(v.tokenId, (byToken.get(v.tokenId) ?? 0) + 1);
    if (ok <= 6) console.log(v.boxId.slice(0, 12), v.takerAction.padEnd(4), "price", v.price.toString().padStart(10), "cap", capacity(v).toString().padStart(12), "value", v.value.toString().padStart(12), v.owner.slice(0, 8), v.tokenId.slice(0, 8));
  } catch (e) {
    bad++;
    console.log("rejected", b.boxId.slice(0, 12), (e as Error).message);
  }
}
console.log(`height ${height}; ${boxes.length} boxes under the template; ${ok} parsed as orders, ${bad} rejected; ${byToken.size} tokens`);
for (const [id, n] of byToken) {
  const t = await explorer.token(id).catch(() => ({ name: "?", decimals: -1 }));
  console.log(`  ${id.slice(0, 10)} ${String(n).padStart(3)}  ${t.name} (${t.decimals} decimals)`);
}
