// Builds test/fixtures/lithos-record.json, the recorded LithosDex transactions the Lithos tests rebuild, from a frozen
// corpus of mainnet transactions (the public "sigma-rust v3 signing" corpus: per transaction the signed tx as the node
// serves it, its input boxes, the inclusion block header and the ten headers before it) plus, for each order box in
// it, the transaction that created that order box, read from the explorer. Public chain data only.
//
//   node scripts/lithos-fixtures.ts <corpus.json> > test/fixtures/lithos-record.json
//
// Kept: every claim transaction (vault op 0); every order box spent in the corpus, with the transaction that placed
// it and that transaction's input boxes; the headers of each claim's block, and of one other block for the synthetic
// cancels; one pool box. Nothing is written but stdout.
import { readFileSync } from "node:fs";
import { describeOrder, VAULT_NFT } from "../src/protocols/lithos/lithos.ts";
import { DEFAULT_EXPLORER, parseExact } from "../src/explorer.ts";

type Json = Record<string, unknown>;
interface CorpusTx {
  txId: string;
  inclusionHeight: number;
  tx: {
    inputs: { boxId: string; spendingProof: { proofBytes: string; extension: Record<string, string> } }[];
    outputs: Json[];
  };
  inputBoxes: (Json & { boxId: string; ergoTree: string; assets: { tokenId: string }[] })[];
  dataInputBoxes: Json[];
  blockHeader: Json;
  lastHeaders: Json[];
}

const corpusPath = process.argv[2];
if (!corpusPath) throw new Error("usage: node scripts/lithos-fixtures.ts <corpus.json>");
const corpus = parseExact(readFileSync(corpusPath, "utf8")) as { txs: CorpusTx[] };
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? JSON.rawJSON(v.toString()) : v);

async function get(path: string): Promise<Json> {
  for (let k = 0; k < 5; k++) {
    const r = await fetch(DEFAULT_EXPLORER + path);
    if (r.ok) return parseExact(await r.text()) as Json;
    await new Promise((s) => setTimeout(s, 1500 * (k + 1)));
  }
  throw new Error(`explorer: ${path}`);
}
/** A box in the node's JSON shape (registers as hex), from the explorer's /boxes/{id}. */
async function box(id: string): Promise<Json> {
  const b = await get(`/api/v1/boxes/${id}`);
  const regs: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.additionalRegisters as Record<string, { serializedValue: string } | string>))
    regs[k] = typeof v === "string" ? v : v.serializedValue;
  return {
    boxId: b.boxId,
    value: b.value,
    ergoTree: b.ergoTree,
    assets: (b.assets as { tokenId: string; amount: bigint }[]).map((a) => ({ tokenId: a.tokenId, amount: a.amount })),
    creationHeight: b.creationHeight,
    additionalRegisters: regs,
    transactionId: b.transactionId,
    index: b.index,
  };
}

const headers: Record<string, { blockHeader: Json; lastHeaders: Json[] }> = {};
const keepHeaders = (t: CorpusTx) =>
  (headers[t.inclusionHeight] = { blockHeader: t.blockHeader, lastHeaders: t.lastHeaders });

const claims = corpus.txs
  .filter(
    (t) => t.inputBoxes[0]?.assets[0]?.tokenId === VAULT_NFT && t.tx.inputs[0].spendingProof.extension["0"] === "0200",
  )
  .map((t) => {
    keepHeaders(t);
    return { txId: t.txId, inclusionHeight: t.inclusionHeight, tx: t.tx, inputBoxes: t.inputBoxes };
  });

const orders = [];
for (const t of corpus.txs)
  for (const b of t.inputBoxes) {
    const v = describeOrder(b as never);
    if (!v) continue;
    const ptx = await get(`/api/v1/transactions/${b.transactionId as string}`);
    const inputs = [];
    for (const i of ptx.inputs as { boxId: string }[]) inputs.push(await box(i.boxId));
    const outputs = (ptx.outputs as Json[]).map((o) => {
      const regs: Record<string, string> = {};
      for (const [k, r] of Object.entries(o.additionalRegisters as Record<string, { serializedValue: string }>))
        regs[k] = r.serializedValue;
      return {
        boxId: o.boxId,
        value: o.value,
        ergoTree: o.ergoTree,
        creationHeight: o.creationHeight,
        assets: (o.assets as { tokenId: string; amount: bigint }[]).map((a) => ({
          tokenId: a.tokenId,
          amount: a.amount,
        })),
        additionalRegisters: regs,
      };
    });
    orders.push({
      kind: v.kind,
      box: b,
      executedIn: t.txId,
      // a redeem order names its provision only through the NFT it holds; the provision is input 1 of its execution
      ...(v.kind === "redeem" ? { provisionBox: t.inputBoxes[1] } : {}),
      placement: { txId: ptx.id, inclusionHeight: ptx.inclusionHeight, inputs, outputs },
    });
  }
// one more block for the synthetic cancels: the newest swap's
const newestSwap = corpus.txs.find((t) => t.inputBoxes.some((b) => describeOrder(b as never)));
if (newestSwap) keepHeaders(newestSwap);
// the pool as the newest swap found it, for the builders' pool check
const poolBox = newestSwap?.inputBoxes[0];

process.stdout.write(
  JSON.stringify(
    {
      $comment:
        "LithosDex mainnet transactions for the Lithos tests, built by scripts/lithos-fixtures.ts from the public sigma-rust v3 signing corpus (fetched 2026-10-28, sha256 17064042ef93dea429b36c8c865b1bfb565ca605299ce48736bd085fee1c4c5c) and, for each order box, its placing transaction from api.ergoplatform.com.",
      cancelHeadersAt: newestSwap?.inclusionHeight,
      poolBox,
      headers,
      claims,
      orders,
    },
    big,
  ) + "\n",
);
