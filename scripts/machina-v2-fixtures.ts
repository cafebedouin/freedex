// Builds test/fixtures/machina-v2-record.json from the public "sigma-rust v3 signing" Machina corpus (mainnet
// transactions spending boxes at one Machina ErgoTree version 2 limit-order address, with their input boxes, the
// inclusion header and the ten before it). Keeps the transactions that spend a version-2 limit order and drops the
// corpus metadata. Integers past 2^53 are kept exact. Public chain data only.
//
//   node scripts/machina-v2-fixtures.ts <corpus-machina.json> > test/fixtures/machina-v2-record.json
import { readFileSync } from "node:fs";
import { parseExact } from "../src/explorer.ts";
import { E2T_V2 } from "../src/protocols/machina/orders.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/machina-v2-fixtures.ts <corpus-machina.json>");
const corpus = parseExact(readFileSync(path, "utf8")) as {
  txs: {
    txId: string;
    inclusionHeight: number;
    tx: unknown;
    inputBoxes: { ergoTree: string }[];
    blockHeader: unknown;
    lastHeaders: unknown[];
  }[];
};
const txs = corpus.txs
  .filter((t) => t.inputBoxes.some((b) => E2T_V2.validate(b.ergoTree)))
  .map(({ txId, inclusionHeight, tx, inputBoxes, blockHeader, lastHeaders }) => ({
    txId,
    inclusionHeight,
    tx,
    inputBoxes,
    blockHeader,
    lastHeaders,
  }));
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? JSON.rawJSON(v.toString()) : v);
process.stdout.write(
  JSON.stringify(
    {
      $comment:
        "Machina version-2 limit-order spends for test/machina-v2.test.ts, built by scripts/machina-v2-fixtures.ts from the public sigma-rust v3 signing Machina corpus (fetched 2026-11-12, sha256 3eb60c6b373deca64c9996ab96c62b1beaad0bf4f3bcd65279e2a53ac8d7d942).",
      txs,
    },
    big,
  ) + "\n",
);
