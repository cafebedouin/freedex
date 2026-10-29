// The sidecar form of the page's upkeep: run every job once against the explorer and submit what pays, bounties to
// the given address. No key anywhere. node scripts/upkeep-run.ts <payToAddress> [--dry]
import { ErgoAddress } from "@fleet-sdk/core";
import { Explorer } from "../src/explorer.ts";
import { JOBS, keylessJson, runUpkeep } from "../src/upkeep.ts";

const payTo = ErgoAddress.fromBase58(process.argv[2]);
const dry = process.argv.includes("--dry");
const explorer = new Explorer(process.env.VITE_EXPLORER);
if (dry) {
  const height = await explorer.height();
  for (const job of JOBS) {
    const cands = await job.find(explorer, height, payTo);
    console.log(`${job.name}: ${cands.length} candidate(s)`);
    for (const c of cands) console.log("  ", c.what, "| id", keylessJson(c.tx).id.slice(0, 12));
  }
} else {
  const r = await runUpkeep(explorer, payTo, (m) => console.log(m));
  console.log(`found ${r.found}, submitted ${r.submitted.length}`);
}
