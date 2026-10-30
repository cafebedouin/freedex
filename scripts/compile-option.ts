// Compile contracts/Call.es and contracts/Put.es with Fleet's compiler to an ErgoTree v1 with segregated
// constants, and print what src/registry.json pins (option-call, option-put): the tree hex, its byte size and the template's SHA-256.
// node scripts/compile-option.ts
// test/hashes.test.ts compiles the same sources the same way and checks them against the pinned trees.
import { readFileSync } from "node:fs";
import { compile } from "@fleet-sdk/compiler";
import { hex, sha256 } from "@fleet-sdk/crypto";

for (const f of ["Call.es", "Put.es"]) {
  const src = readFileSync(new URL(`../contracts/${f}`, import.meta.url), "utf8");
  const tree = compile(src, { version: 1, segregateConstants: true });
  console.log(
    `${f}: ${tree.bytes.length} bytes, template sha256 ${hex.encode(sha256(tree.template))}\n${tree.toHex()}`,
  );
}
