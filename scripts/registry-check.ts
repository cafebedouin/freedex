// Asks the explorer for one live mainnet box per registry entry and prints the count, for the record; where none is
// unspent today it names the newest spent one and the all-time count instead. Reads only; updates nothing (the
// liveBoxCheckedOn dates in src/registry.json are set by hand from this output).
//   node scripts/registry-check.ts
// A template entry is searched by its template hash (the explorer's unspent search); a recipient (a P2PK tree) is
// searched by its address; an entry whose protocol keeps no live box is reported as such, not as a failure.
import { ErgoAddress } from "@fleet-sdk/core";
import { Explorer } from "../src/explorer.ts";
import { REGISTRY } from "../src/registry.ts";

const explorer = new Explorer(process.env.VITE_EXPLORER);
let live = 0;
const entries = Object.entries(REGISTRY);
console.log(`registry: ${entries.length} entries; explorer ${explorer.base}; height ${await explorer.height()}`);
for (const [id, e] of entries) {
  let line: string;
  try {
    if (e.kind === "recipient") {
      const address = ErgoAddress.fromErgoTree(e.tree!).encode();
      const boxes = await explorer.unspentByAddress(address, 1);
      line = `${boxes.length ? "live" : "none"}: recipient ${address.slice(0, 10)}… ${boxes[0]?.boxId.slice(0, 16) ?? ""}`;
      if (boxes.length) live++;
    } else {
      // up to twenty unspent boxes under the hash: a template hash also matches another deployment of the same
      // script with other constants, which the describers refuse, so the first with the pinned bytes is the one
      const boxes = e.nft ? await explorer.byToken(e.nft, 1) : await explorer.byTemplate(e.templateSha256, 20);
      const match = e.tree ? (boxes.find((b) => b.ergoTree === e.tree) ?? boxes[0]) : boxes[0];
      const others = e.tree ? boxes.filter((b) => b.ergoTree !== e.tree).length : 0;
      if (!match) {
        // nothing unspent today: the explorer's all-time listing under the template hash, spent boxes included
        const r = await fetch(`${explorer.base}/api/v1/boxes/byErgoTreeTemplateHash/${e.templateSha256}?limit=1`);
        const j = (await r.json()) as {
          items: { boxId: string; ergoTree: string; settlementHeight: number }[];
          total: number;
        };
        const b = j.items[0];
        if (!b) line = "none, ever";
        else {
          const sameTree = e.tree ? b.ergoTree === e.tree : true;
          line = `spent: box ${b.boxId.slice(0, 16)}… settled at height ${b.settlementHeight}, ${j.total} all time${sameTree ? "" : " (TREE DIFFERS)"}`;
          if (sameTree) live++;
        }
      } else {
        const sameTree = e.tree ? match.ergoTree === e.tree : true;
        line = `live: box ${match.boxId.slice(0, 16)}… at height ${match.creationHeight}${sameTree ? "" : " (TREE DIFFERS)"}${others ? `; ${others} of ${boxes.length} listed carry other constants` : ""}`;
        if (sameTree) live++;
      }
    }
  } catch (err) {
    line = `error: ${(err as Error).message}`;
  }
  console.log(`${id.padEnd(30)} ${e.templateSha256.slice(0, 12)}… ${line}`);
}
console.log(
  `${live} of ${entries.length} entries have a mainnet box (unspent, or spent where none is open) with the pinned bytes`,
);
