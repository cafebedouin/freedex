// Extract SigmaFi's deployed contract hex from its MIT-licensed UI source (capt-nemo429/sigmafi-ui,
// src/offchain/plugins.ts) into src/sigmafi-contracts.json, and count the live boxes under each template.
//   node scripts/sigmafi-constants.mjs <path/to/plugins.ts> [--count]
import { readFileSync, writeFileSync } from "node:fs";
import { ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
const src = readFileSync(process.argv[2], "utf8");
function block(name) {
  const i = src.indexOf(`export const ${name} =`);
  if (i < 0) throw new Error(`no ${name}`);
  const j = src.indexOf(";", i);
  return [...src.slice(i, j).matchAll(/"([0-9a-f]{8,})"/g)].map((m) => m[1]);
}
const c = {
  orderOnCloseErg: block("ORDER_ON_CLOSE_ERG_CONTRACT")[0],
  orderFixedErg: block("ORDER_FIXED_ERG_CONTRACT")[0],
  orderOnCloseTokenTemplate: block("ORDER_ON_CLOSE_TOKEN_CONTRACT_TEMPLATE"),
  orderFixedTokenTemplate: block("ORDER_FIXED_TOKEN_CONTRACT_TEMPLATE"),
  bondErg: block("ERG_BOND_CONTRACT")[0],
  bondTokenTemplate: block("TOKEN_BOND_CONTRACT_TEMPLATE"),
  devFeeTree: src.match(/CONTRACT_DEV_FEE_CONTRACT =\s*"([0-9a-f]+)"/)[1],
};
const dummyTok = "00".repeat(32), dummyHash = "11".repeat(32);
const sample = {
  orderOnCloseErg: c.orderOnCloseErg,
  orderFixedErg: c.orderFixedErg,
  bondErg: c.bondErg,
  orderOnCloseToken: c.orderOnCloseTokenTemplate[0] + dummyTok + c.orderOnCloseTokenTemplate[1] + dummyHash + c.orderOnCloseTokenTemplate[2],
  orderFixedToken: c.orderFixedTokenTemplate[0] + dummyTok + c.orderFixedTokenTemplate[1] + dummyHash + c.orderFixedTokenTemplate[2],
  bondToken: c.bondTokenTemplate[0] + dummyTok + c.bondTokenTemplate[1],
};
const templateSha256 = {};
for (const [k, tree] of Object.entries(sample)) templateSha256[k] = hex.encode(sha256(new ErgoTree(tree).template));
writeFileSync(new URL("../src/sigmafi-contracts.json", import.meta.url), JSON.stringify({ source: "capt-nemo429/sigmafi-ui src/offchain/plugins.ts (MIT), read 2026-10-29", ...c, templateSha256 }, null, 1));
console.log("wrote src/sigmafi-contracts.json");
if (process.argv.includes("--count")) {
  for (const [k, h] of Object.entries(templateSha256)) {
    const r = await fetch("https://api.ergoplatform.com/api/v1/boxes/unspent/search?limit=100", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ergoTreeTemplateHash: h }) });
    const j = await r.json();
    console.log(k.padEnd(18), "tree", String(sample[k].length / 2).padStart(4), "B  sha256", h, " live:", j.total);
  }
}
