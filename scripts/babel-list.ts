import { ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import { parseExact } from "../src/explorer.ts";
import tokenlist from "../src/tokenlist.json" with { type: "json" };
const TPL =
  "100604000e20{tokenId}0400040005000500d803d601e30004d602e4c6a70408d603e4c6a7050595e67201d804d604b2a5e4720100d605b2db63087204730000d606db6308a7d60799c1a7c17204d1968302019683050193c27204c2a7938c720501730193e4c672040408720293e4c672040505720393e4c67204060ec5a796830201929c998c7205029591b1720673028cb272067303000273047203720792720773057202";
const tree = TPL.replace("{tokenId}", "00".repeat(32));
const h = hex.encode(sha256(new ErgoTree(tree).template));
console.log("babel template sha256", h, "tree bytes", tree.length / 2);
const EXP = "https://api.ergoplatform.com/api/v1";
const all = parseExact(
  await (
    await fetch(`${EXP}/boxes/unspent/search?limit=500`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ergoTreeTemplateHash: h }),
    })
  ).text(),
) as {
  total: number;
  items: {
    boxId: string;
    ergoTree: string;
    value: bigint;
    creationHeight: number;
    assets: { amount: bigint }[];
    additionalRegisters: Record<string, { renderedValue?: string }>;
  }[];
};
console.log("live babel boxes:", all.total);
const wl = new Map(tokenlist.tokens.map((t) => [t.id, t]));
let n = 0;
for (const b of all.items) {
  const tokenId = b.ergoTree.slice(TPL.indexOf("{tokenId}"), TPL.indexOf("{tokenId}") + 64);
  const t = wl.get(tokenId);
  if (!t) continue;
  n++;
  if (n <= 12)
    console.log(
      b.boxId.slice(0, 10),
      t.name.padEnd(10),
      "bid",
      b.additionalRegisters.R5?.renderedValue,
      "nanoERG/unit; ERG",
      (Number(b.value) / 1e9).toFixed(4),
      "tokens",
      b.assets[0]?.amount ?? 0,
      "h",
      b.creationHeight,
    );
}
console.log("babel boxes for whitelisted tokens:", n);
