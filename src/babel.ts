// EIP-31 Babel boxes: standing keyless bids for a token, priced in nanoERG per unit. A bid above the pool's price is
// an arbitrage anyone may take in one keyless transaction (pool + Babel box in, both recreated, the gap to whoever
// builds it). This is the repo's mainnet "Babel take" (skunks/upkeep/mainnet/babel-take.py) in TypeScript.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, ErgoUnsignedInput, OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import { SByte, SColl, SConstant, SInt } from "@fleet-sdk/serializer";
import { POOL_TREE, describePool, type PoolView } from "./amm.ts";
import { FEE } from "./orders.ts";

/** EIP-31 contract template; the token id replaces the placeholder at hex offset 12. */
export const BABEL_TEMPLATE =
  "100604000e20{tokenId}0400040005000500d803d601e30004d602e4c6a70408d603e4c6a7050595e67201d804d604b2a5e4720100d605b2db63087204730000d606db6308a7d60799c1a7c17204d1968302019683050193c27204c2a7938c720501730193e4c672040408720293e4c672040505720393e4c67204060ec5a796830201929c998c7205029591b1720673028cb272067303000273047203720792720773057202";
const TOKEN_AT = BABEL_TEMPLATE.indexOf("{tokenId}");
/** SHA-256 of the template, the same for every token (scripts/babel-list.ts, 2026-10-29). */
export const BABEL_TEMPLATE_SHA256 = "4e83fa68ef3ed9794bbab5d8799998a9e09fb10a0afe8d1bf928936dfd11c465";

export function babelTree(tokenId: string): string {
  return BABEL_TEMPLATE.replace("{tokenId}", tokenId);
}

export interface BabelView {
  boxId: string;
  tokenId: string;
  /** nanoERG the owner pays per smallest token unit */
  bid: bigint;
  /** ERG left to pay with */
  value: bigint;
  /** tokens already collected */
  tokens: bigint;
  owner: string;
}

export function describeBabel(box: Box<Amount>): BabelView {
  const tokenId = box.ergoTree.slice(TOKEN_AT, TOKEN_AT + 64);
  if (box.ergoTree !== babelTree(tokenId)) throw new Error("not an EIP-31 Babel box");
  const r4 = box.additionalRegisters.R4, r5 = box.additionalRegisters.R5;
  if (!r4 || !r5) throw new Error("Babel box lacks R4 or R5");
  const tok = box.assets[0];
  if (tok && tok.tokenId !== tokenId) throw new Error("Babel box holds the wrong token");
  return {
    boxId: box.boxId,
    tokenId,
    bid: BigInt(SConstant.from<bigint>(r5).data),
    value: BigInt(box.value),
    tokens: tok ? BigInt(tok.amount) : 0n,
    owner: ErgoAddress.fromPublicKey(SConstant.from<Uint8Array>(r4).data).encode(),
  };
}

/** The recreated Babel box keeps at least this much ERG (a box needs a minimum value; the mainnet takes left 0.001). */
export const BABEL_KEEP = 1_000_000n;

export interface BabelTake {
  /** tokens bought from the pool and sold to the Babel box */
  t: bigint;
  /** nanoERG paid into the pool (the pool's rule, minimal) */
  dx: bigint;
  /** nanoERG taken from the Babel box (at most t * bid, at most its ERG minus the keep) */
  y: bigint;
  /** what is left for whoever builds it, after the miner fee */
  payout: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const bmin = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Best take of a Babel bid against a pool, or undefined if none pays. Pool rule for dX > 0:
 * y0 * dX * fee >= T * (x0 * 1000 + dX * fee), so dX = ceil(T * x0 * 1000 / (fee * (y0 - T))). The Babel box
 * pays min(T * bid, cap). Profit in T is concave, so a ternary search then a scan of the neighbourhood.
 */
export function sizeBabelTake(pool: PoolView, babel: BabelView, fee = FEE): BabelTake | undefined {
  if (pool.tokenId !== babel.tokenId) throw new Error("the pool's token is not the Babel box's token");
  const cap = babel.value - BABEL_KEEP;
  if (cap <= 0n || babel.bid <= 0n) return undefined;
  const cost = (t: bigint) => ceilDiv(t * pool.x * 1000n, pool.feeNum * (pool.y - t));
  const profit = (t: bigint) => bmin(t * babel.bid, cap) - cost(t);
  let lo = 1n;
  let hi = bmin(ceilDiv(cap, babel.bid), pool.y - 1n);
  if (hi < lo) return undefined;
  while (hi - lo > 4n) {
    const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
    if (profit(m1) < profit(m2)) lo = m1 + 1n;
    else hi = m2 - 1n;
  }
  let best = 0n, bestProfit = -1n;
  for (let k = lo - 4n > 1n ? lo - 4n : 1n; k <= hi + 4n; k++) {
    if (k <= 0n || k >= pool.y) continue;
    const p = profit(k);
    if (p > bestProfit) [best, bestProfit] = [k, p];
  }
  if (best === 0n) return undefined;
  const t = best;
  const y = bmin(t * babel.bid, cap);
  const dx = cost(t);
  const payout = y - dx - fee;
  if (payout <= 0n) return undefined;
  return { t, dx, y, payout };
}

export interface BabelTakeParams {
  height: number;
  poolBox: Box<Amount>;
  babelBox: Box<Amount>;
  payTo: ErgoAddress;
}

/** The keyless take: no input needs a signature; the fee comes out of the gap. */
export function buildBabelTake(p: BabelTakeParams): { tx: EIP12UnsignedTransaction; take: BabelTake } | undefined {
  const pool = describePool(p.poolBox);
  const babel = describeBabel(p.babelBox);
  const take = sizeBabelTake(pool, babel);
  if (!take) return undefined;
  const poolOut = new OutputBuilder(pool.x + take.dx, POOL_TREE)
    .addTokens([
      { tokenId: pool.nft, amount: 1n },
      { tokenId: pool.lpTokenId, amount: BigInt(p.poolBox.assets[1].amount) },
      { tokenId: pool.tokenId, amount: pool.y - take.t },
    ])
    .setAdditionalRegisters({ R4: p.poolBox.additionalRegisters.R4 as string });
  const babelOut = new OutputBuilder(babel.value - take.y, p.babelBox.ergoTree)
    .addTokens({ tokenId: babel.tokenId, amount: babel.tokens + take.t })
    .setAdditionalRegisters({
      R4: p.babelBox.additionalRegisters.R4 as string,
      R5: p.babelBox.additionalRegisters.R5 as string,
      R6: SColl(SByte, babel.boxId).toHex(),
    });
  const payout = new OutputBuilder(take.payout, p.payTo);
  const babelIn = new ErgoUnsignedInput(p.babelBox).setContextExtension({ 0: SInt(1) }); // recreated Babel box is output 1
  const tx = new TransactionBuilder(p.height)
    .from([p.poolBox, babelIn])
    .to([poolOut, babelOut, payout])
    .payFee(FEE)
    .build()
    .toEIP12Object();
  return { tx, take };
}
