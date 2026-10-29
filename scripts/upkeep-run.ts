// The sidecar form of the page's upkeep: run every job once against the explorer and submit what pays, bounties to
// the given address. No key anywhere. node scripts/upkeep-run.ts <payToAddress> [--dry] [--every <seconds>]
// Jobs: Babel bids and Machina orders priced across their pool, and the legs of clocked boxes that are due
// (src/upkeep.ts JOBS). With --every the runner repeats until stopped, which is how a program's legs get executed.
import { ErgoAddress } from "@fleet-sdk/core";
import { Explorer } from "../src/explorer.ts";
import { JOBS, keylessJson, runUpkeep } from "../src/upkeep.ts";

const payTo = ErgoAddress.fromBase58(process.argv[2]);
const dry = process.argv.includes("--dry");
const everyAt = process.argv.indexOf("--every");
const every = everyAt > 0 ? Number(process.argv[everyAt + 1]) : 0;
const explorer = new Explorer(process.env.VITE_EXPLORER);
if (dry) {
  const height = await explorer.height();
  for (const job of JOBS) {
    const cands = await job.find(explorer, height, payTo);
    console.log(`${job.name}: ${cands.length} candidate(s)`);
    for (const c of cands) console.log("  ", c.what, "| id", keylessJson(c.tx).id.slice(0, 12));
  }
} else {
  const recent = new Map<string, number>();
  do {
    const r = await runUpkeep(explorer, payTo, (m) => console.log(`${new Date().toISOString()} ${m}`), recent);
    console.log(
      `${new Date().toISOString()} height ${await explorer.height()}: found ${r.found}, submitted ${r.submitted.length}`,
    );
    if (every > 0) await new Promise((res) => setTimeout(res, every * 1000));
  } while (every > 0);
}
