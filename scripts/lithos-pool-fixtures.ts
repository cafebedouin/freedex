// Builds test/fixtures/lithos-pool-record.json, the recorded transactions that spend the LithosDex pool box (swaps,
// deposits, redemptions, flushes, the resize), from the same frozen corpus of mainnet transactions as
// scripts/lithos-fixtures.ts (per transaction the signed tx as the node serves it, its input boxes, the inclusion
// block header and the ten headers before it). Public chain data only; nothing is fetched.
//
//   node scripts/lithos-pool-fixtures.ts <corpus.json> > test/fixtures/lithos-pool-record.json
//
// Kept: every corpus transaction whose input 0 is the pool box, with its inputs (box id and context extension), its
// outputs and its input boxes; the headers of every block holding one that is not a swap, and of the block of the one
// swap made straight against the pool. To keep the file small, the pool's tree (2113 bytes, in two boxes of every
// transaction) is written as "POOL_TREE"; the loader puts it back and checks every box id against its bytes.
import { readFileSync } from "node:fs";
import { POOL_TREE } from "../src/protocols/lithos/lithos.ts";
import { parseExact } from "../src/explorer.ts";

type Json = Record<string, unknown>;
interface CorpusTx {
  txId: string;
  inclusionHeight: number;
  tx: { inputs: { boxId: string; spendingProof: { extension: Record<string, string> } }[]; outputs: Json[] };
  inputBoxes: (Json & { ergoTree: string })[];
  blockHeader: Json;
  lastHeaders: Json[];
}

const corpusPath = process.argv[2];
if (!corpusPath) throw new Error("usage: node scripts/lithos-pool-fixtures.ts <corpus.json>");
const corpus = parseExact(readFileSync(corpusPath, "utf8")) as { txs: CorpusTx[] };
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? JSON.rawJSON(v.toString()) : v);

const txs = corpus.txs.filter((t) => t.inputBoxes[0]?.ergoTree === POOL_TREE);
const op = (t: CorpusTx) => t.tx.inputs[0].spendingProof.extension["0"];
const direct = (t: CorpusTx) => t.inputBoxes.slice(1).every((b) => b.ergoTree.startsWith("0008cd"));
const headers: Record<string, { blockHeader: Json; lastHeaders: Json[] }> = {};
for (const t of txs)
  if (op(t) !== "0200" || direct(t))
    headers[t.inclusionHeight] = { blockHeader: t.blockHeader, lastHeaders: t.lastHeaders };

const out = {
  source:
    "the public sigma-rust v3 signing corpus (mainnet); every transaction in it whose input 0 is the LithosDex pool",
  headers,
  txs: txs.map((t) => ({
    txId: t.txId,
    inclusionHeight: t.inclusionHeight,
    tx: {
      inputs: t.tx.inputs.map((i) => ({ boxId: i.boxId, extension: i.spendingProof.extension })),
      outputs: t.tx.outputs,
    },
    inputBoxes: t.inputBoxes,
  })),
};
process.stdout.write(JSON.stringify(out, big).replaceAll(POOL_TREE, "POOL_TREE") + "\n");
