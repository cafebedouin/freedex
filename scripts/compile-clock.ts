// Compile contracts/Clock.es (and ClockSell.es when present) with Fleet's compiler to an ErgoTree v1 with
// segregated constants, and print what src/clock.ts pins: the tree hex, its byte size and the template's SHA-256.
// node scripts/compile-clock.ts
// test/hashes.test.ts compiles the same source the same way and checks it against the pinned tree.
import { readFileSync } from "node:fs";
import { compile } from "@fleet-sdk/compiler";
import { hex, sha256 } from "@fleet-sdk/crypto";
import { CLOCK_SLACK } from "../src/clock.ts";

for (const f of ["Clock.es"]) {
  const src = readFileSync(new URL(`../contracts/${f}`, import.meta.url), "utf8").replace(
    /\$SLACK/g,
    String(CLOCK_SLACK),
  );
  const tree = compile(src, { version: 1, segregateConstants: true });
  console.log(
    `${f}: ${tree.bytes.length} bytes, template sha256 ${hex.encode(sha256(tree.template))}\n${tree.toHex()}`,
  );
}
