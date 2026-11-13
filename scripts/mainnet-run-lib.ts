// The parts of scripts/mainnet-run.ts that decide which boxes a step may spend and whether the node a caller will
// submit to can see them; no network of their own (the node check takes a fetch), so test/mainnet-run.test.ts runs them.
import type { Box } from "@fleet-sdk/common";

type AnyBox = Pick<Box<string | bigint>, "boxId" | "assets">;

/**
 * The boxes a provider step may spend: with `--use`, exactly the boxes the caller named (already narrowed to them;
 * the token filter would otherwise refuse a provision NFT that sits beside other tokens); without it, the boxes
 * holding no token but those in `ok`.
 */
export function providerFilter<T extends AnyBox>(inputs: T[], ok: Set<string>, use: string[]): T[] {
  if (use.length) return inputs;
  return inputs.filter((b) => b.assets.every((a) => ok.has(a.tokenId)));
}

/** The boxes holding none of `tokenIds` (L4 leaves a provision's ownership NFT where it is). */
export function withoutTokens<T extends AnyBox>(inputs: T[], tokenIds: Set<string>): T[] {
  return inputs.filter((b) => b.assets.every((a) => !tokenIds.has(a.tokenId)));
}

/** How much of a token the boxes hold. */
export function heldIn(boxes: AnyBox[], tokenId: string): bigint {
  let sum = 0n;
  for (const b of boxes) for (const a of b.assets) if (a.tokenId === tokenId) sum += BigInt(a.amount);
  return sum;
}

export type Visibility = "utxo" | "mempool" | "missing" | `error: ${string}`;

/**
 * Whether a node sees each box: `GET /utxo/byId/<id>` (the confirmed UTXO set), and on a 404
 * `GET /utxo/withPool/byId/<id>` (the same with the node's mempool, which is what it validates a submission against).
 */
export async function nodeVisibility(
  node: string,
  ids: string[],
  fetchFn: (url: string) => Promise<{ status: number }> = fetch,
): Promise<Map<string, Visibility>> {
  const base = node.replace(/\/+$/, "");
  const out = new Map<string, Visibility>();
  for (const id of ids) {
    try {
      const r = await fetchFn(`${base}/utxo/byId/${id}`);
      if (r.status === 200) {
        out.set(id, "utxo");
        continue;
      }
      if (r.status !== 404) {
        out.set(id, `error: HTTP ${r.status}`);
        continue;
      }
      const p = await fetchFn(`${base}/utxo/withPool/byId/${id}`);
      out.set(id, p.status === 200 ? "mempool" : p.status === 404 ? "missing" : `error: HTTP ${p.status}`);
    } catch (e) {
      out.set(id, `error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** The lines the script prints for the node check, and why it refuses to write, if it does. */
export function visibilityReport(node: string, seen: Map<string, Visibility>): { lines: string[]; refuse?: string } {
  const lines = [...seen].map(
    ([id, v]) =>
      `  node ${node}: ${id.slice(0, 12)}… ${v === "utxo" ? "in its UTXO set" : v === "mempool" ? "in its mempool only (a chained spend; it accepts that)" : v === "missing" ? "NOT VISIBLE (404 with and without the mempool)" : v}`,
  );
  const bad = [...seen].filter(([, v]) => v === "missing" || v.startsWith("error"));
  if (!bad.length) return { lines };
  return {
    lines,
    refuse: `not writing: ${bad.length} input box${bad.length === 1 ? "" : "es"} not visible at ${node} (${bad.map(([id]) => id.slice(0, 12) + "…").join(", ")}); the node is behind the explorer, or the box is spent. Wait a block and rerun`,
  };
}
