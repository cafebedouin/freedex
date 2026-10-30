// Regenerate the static token list: every token whose deepest ErgoDEX v1 pool holds at least MIN_ERG.
//   node scripts/tokens.ts > src/tokenlist.json
import { Explorer } from "../src/explorer.ts";
import { describePool } from "../src/protocols/ergodex/amm.ts";

const MIN_ERG = 100n * 1_000_000_000n;
const pools = await new Explorer().pools(500);
const best = new Map<string, { id: string; name: string; decimals: number; poolNft: string; poolErg: string }>();
for (const p of pools) {
  const v = describePool(p.box);
  if (v.x < MIN_ERG) continue;
  const cur = best.get(v.tokenId);
  if (!cur || BigInt(cur.poolErg) < v.x)
    best.set(v.tokenId, {
      id: v.tokenId,
      name: p.tokenName,
      decimals: p.tokenDecimals,
      poolNft: v.nft,
      poolErg: v.x.toString(),
    });
}
const list = [...best.values()].sort((a, b) => (BigInt(b.poolErg) > BigInt(a.poolErg) ? 1 : -1));
console.log(
  JSON.stringify(
    { generated: new Date().toISOString().slice(0, 10), minPoolErg: MIN_ERG.toString(), tokens: list },
    null,
    1,
  ),
);
