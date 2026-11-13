// LithosDex: the ERG/LIT pool of the Lithos protocol, its fee vault and provisions, and the four order contracts
// (swap ERG for LIT, swap LIT for ERG, deposit, redeem) an off-chain executor fills against the pool. Pure: no DOM,
// no network. Every script here is ErgoTree version 3, which a wallet library must be able to parse to sign any
// input under it (ergo-lib-wasm 0.29; 0.28.0 cannot). Placing an order spends only the wallet's own boxes, so any
// wallet can sign it; a cancel spends the order box and a claim spends the vault and provision boxes.
//
// The pool, the vault and the provision guard hold no key: the pool accepts any transaction that satisfies its
// arithmetic, so a wallet can also swap, deposit, redeem, flush and resize against it directly, in one transaction
// each, without an order or an executor fee (the official client's LithosDexTransactions builds the same seven).
// Who may do what is the provision logic's call: claim, redeem and resize need the provision's ownership NFT among
// the inputs; a flush and a refresh need nothing but the fee.
//
//   place order  IN  wallet...                          OUT order, [change], fee
//   cancel       IN  order, [wallet...]                 OUT the owner's change (order value and tokens less the fee), fee
//   claim        IN  vault, provision 1..n, wallet...   OUT vault, provision 1..n, [change: the fees owed], fee
//                (one wallet input holds each provision's ownership NFT)
//   swap         IN  pool, wallet...                    OUT pool, fee, change (what the pool pays)
//   deposit      IN  pool, wallet...                    OUT pool, provision, ownership NFT (minted), fee, [change]
//   redeem       IN  pool, provision, NFT box, wallet.. OUT pool, payout, fee, [change]         (NFT burned)
//   flush        IN  pool, vault, wallet...             OUT pool, vault, fee, [change]
//   resize       IN  pool, provision, vault, NFT box..  OUT pool, provision, vault, fee, [change]
//   refresh      IN  provision, wallet...               OUT provision (young again), fee, [change]
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import {
  ErgoAddress,
  ErgoTree,
  ErgoUnsignedInput,
  FEE_CONTRACT,
  OutputBuilder,
  TransactionBuilder,
} from "@fleet-sdk/core";
import { blake2b256, hex, sha256 } from "@fleet-sdk/crypto";
import { SBigInt, SByte, SColl, SConstant, SGroupElement, SInt, SLong, SSigmaProp } from "@fleet-sdk/serializer";
import { contract, treeOf } from "../../registry.ts";
import { FEE } from "../machina/orders.ts";

// ---------------------------------------------------------------------------------------------------------------
// The deployment (mainnet). Every id below is also a constant of a pinned tree; `checkDeployment` ties them together.
// ---------------------------------------------------------------------------------------------------------------

export const POOL_NFT = "c0b21ac51481a5d242809d9b1e189a8baf3803fe347ca01833c1aeb380e6eb29";
export const VAULT_NFT = "7f45bcbf13b9925c3eef35ff247ae46b80db2e2703ce2a8bfddf294e1e60c2d7";
export const PROVISION_TOKEN = "b279187c993465c666cb17646fb87325dd7d03de6ac16dfac9c50eaea71f2fc6";
/** The pool's token side: LIT. */
export const LIT = "c1980d829988229516430a47a5eca376060b6ce859616db0936e78ab25cb6de7";

export const POOL_TREE = treeOf("lithosdex-pool");
export const VAULT_TREE = treeOf("lithosdex-fee-vault");
export const PROVISION_GUARD_TREE = treeOf("lithosdex-provision-guard");
/** LD_Provision as passed in context variable 64 of every provision spend. */
export const PROVISION_LOGIC: string = (() => {
  const e = contract("lithosdex-provision-logic") as { value?: string; blake2b256?: string };
  if (!e.value || hex.encode(blake2b256(hex.decode(e.value))) !== e.blake2b256)
    throw new Error("registry: lithosdex-provision-logic does not hash to its recorded blake2b256");
  return e.value;
})();

// In-script constants, copied from the .ergo sources (LDHelpers.scala mirrors them too)
/** LD_LiquidityPool CONST_LOCKED_LP: supply is this less R4. */
export const LOCKED_LP = 0x7fffffffffffffffn;
export const FEE_DENOM = 10_000n;
/** LD_LiquidityPool / LD_Provision CONST_PROVISION_MIN: a provision box holds at least this. */
export const PROVISION_MIN = 600_000_000n;
/** LD_FeeVault CONST_VAULT_MIN: never paid out. */
export const VAULT_MIN = 100_000_000n;
/** LD_LiquidityPool / LD_FeeVault CONST_SCALE: the accumulators' fixed point, 1e27. */
export const SCALE = 10n ** 27n;
/** LD_LiquidityPool CONST_MIN_RENT: the pool box holds strictly more. */
export const POOL_MIN_VALUE = 10_000_000n;
/** LD_LiquidityPool CONST_MIN_SUPPLY: no redemption or shrink takes the supply below this. */
export const MIN_SUPPLY = 1_000_000n;
/** LD_Provision CONST_REFRESH_AGE: anyone may refresh a provision box created more than this many blocks ago. */
export const REFRESH_AGE = 525_600;
/** LD_Provision CONST_HEIGHT_SLACK: a refreshed box's creation height must be above HEIGHT less this. */
export const HEIGHT_SLACK = 1_000;
/** LithosDexTransactions.OWNER_BOX_VALUE: the box a direct deposit mints the ownership NFT into. */
export const OWNER_BOX_VALUE = 1_000_000n;

/** Pool operations (context variable 0 of the pool input). */
export const POOL_OP = { swap: 0, deposit: 1, redeem: 2, flush: 3, resize: 4 } as const;
export const VAULT_OP = { claim: 0, flush: 1 } as const;
export const PROVISION_OP = { claim: 0, redeem: 1, refresh: 2, resize: 3 } as const;
export const PROVISION_LOGIC_VAR = 64;

/**
 * ERG an order box holds beyond what its fill spends, returned with the fill (LDOrderTransactions.RETURNED: the
 * executor refuses a reward box under 0.001 ERG).
 */
export const RETURNED = 1_000_000n;
/** The official client's default terms (application.conf `lithosdex.orders`): what the shipped executors accept. */
export const DEFAULT_EXECUTOR_FEE = 3_000_000n;
export const DEFAULT_MAX_MINER_FEE = 1_000_000n;

/** Each pinned tree's constants agree with the ids above; a mismatched registry would build against another pool. */
export function checkDeployment(): void {
  const pool = new ErgoTree(POOL_TREE);
  const guardHash = hex.encode(blake2b256(hex.decode(PROVISION_GUARD_TREE)));
  const constHex = (t: ErgoTree, i: number) => hex.encode(t.constants[i].data as Uint8Array);
  if (constHex(pool, 15) !== guardHash) throw new Error("pool tree: constant 15 is not the provision guard's hash");
  if (constHex(pool, 16) !== VAULT_NFT) throw new Error("pool tree: constant 16 is not the vault NFT");
  const vault = new ErgoTree(VAULT_TREE);
  if (constHex(vault, 17) !== PROVISION_TOKEN) throw new Error("vault tree: constant 17 is not the provision token");
  if (constHex(vault, 28) !== POOL_NFT) throw new Error("vault tree: constant 28 is not the pool NFT");
  const guard = new ErgoTree(PROVISION_GUARD_TREE);
  if (constHex(guard, 0) !== hex.encode(blake2b256(hex.decode(PROVISION_LOGIC))))
    throw new Error("provision guard: its constant is not the provision logic's hash");
}
checkDeployment();

// ---------------------------------------------------------------------------------------------------------------
// Order templates
// ---------------------------------------------------------------------------------------------------------------

export type OrderKind = "swap-sell" | "swap-buy" | "deposit" | "redeem";
export const ORDER_KINDS: OrderKind[] = ["swap-sell", "swap-buy", "deposit", "redeem"];

type Term =
  | "CONST_REDEEMER"
  | "CONST_POOL_NFT"
  | "CONST_EXECUTOR_FEE"
  | "CONST_MAX_MINER_FEE"
  | "CONST_BASE_AMOUNT"
  | "CONST_MIN_QUOTE"
  | "CONST_DEPOSIT_X"
  | "CONST_MIN_SHARES";

interface Template {
  kind: OrderKind;
  sample: string;
  parameters: Partial<Record<Term, number>>;
  templateSha256: string;
}

const SENTINEL_BASE = 0x4c444f5200000000n;
const SENTINEL_ORDER: Term[] = [
  "CONST_EXECUTOR_FEE",
  "CONST_MAX_MINER_FEE",
  "CONST_BASE_AMOUNT",
  "CONST_MIN_QUOTE",
  "CONST_DEPOSIT_X",
  "CONST_MIN_SHARES",
];
const GENERATOR = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

function loadTemplate(kind: OrderKind): Template {
  const e = contract(`lithosdex-order-${kind}`) as {
    sampleTree?: string;
    parameters?: Record<string, number>;
    templateSha256: string;
  };
  if (!e.sampleTree || !e.parameters) throw new Error(`registry: lithosdex-order-${kind} is not parameterized`);
  const t = new ErgoTree(e.sampleTree);
  if (hex.encode(sha256(t.template)) !== e.templateSha256)
    throw new Error(`registry: lithosdex-order-${kind} does not hash to its template`);
  // every parameter index holds its sentinel, as LDOrderContracts.fromTree requires of the pinned tree
  for (const [name, i] of Object.entries(e.parameters) as [Term, number][]) {
    const c = t.constants[i];
    const ok =
      name === "CONST_REDEEMER"
        ? c.type.toString() === "SSigmaProp" && hex.encode(c.data as Uint8Array) === GENERATOR
        : name === "CONST_POOL_NFT"
          ? hex.encode(c.data as Uint8Array) === "5d".repeat(32)
          : c.data === SENTINEL_BASE + BigInt(SENTINEL_ORDER.indexOf(name) + 1) * 0x0101010101n;
    if (!ok) throw new Error(`registry: lithosdex-order-${kind} constant ${i} is not the ${name} sentinel`);
  }
  return { kind, sample: e.sampleTree, parameters: e.parameters, templateSha256: e.templateSha256 };
}

const TEMPLATES: Record<OrderKind, Template> = Object.fromEntries(
  ORDER_KINDS.map((k) => [k, loadTemplate(k)]),
) as Record<OrderKind, Template>;

export function orderTemplateSha256(kind: OrderKind): string {
  return TEMPLATES[kind].templateSha256;
}

export interface OrderTerms {
  /** the owner's public key (33 bytes, hex): receives the fill, and is the only key that refunds */
  owner: string;
  poolNft: string;
  executorFee: bigint;
  maxMinerFee: bigint;
  /** swap-sell: nanoERG sold */
  baseAmount?: bigint;
  /** swap-sell: fewest LIT units; swap-buy: fewest nanoERG after the executor fee */
  minQuote?: bigint;
  /** deposit: most nanoERG offered to the reserves */
  depositX?: bigint;
  /** deposit: fewest shares */
  minShares?: bigint;
}

const TERM_FIELD: Record<Term, keyof OrderTerms> = {
  CONST_REDEEMER: "owner",
  CONST_POOL_NFT: "poolNft",
  CONST_EXECUTOR_FEE: "executorFee",
  CONST_MAX_MINER_FEE: "maxMinerFee",
  CONST_BASE_AMOUNT: "baseAmount",
  CONST_MIN_QUOTE: "minQuote",
  CONST_DEPOSIT_X: "depositX",
  CONST_MIN_SHARES: "minShares",
};

/** The order's tree: the pinned template with each term's constant replaced. Refuses a missing or negative term. */
export function orderTree(kind: OrderKind, terms: OrderTerms): string {
  const t = TEMPLATES[kind];
  let tree = new ErgoTree(t.sample);
  for (const [name, i] of Object.entries(t.parameters) as [Term, number][]) {
    const v = terms[TERM_FIELD[name]];
    if (v === undefined) throw new Error(`${kind} order needs ${TERM_FIELD[name]}`);
    if (name === "CONST_REDEEMER") {
      if (typeof v !== "string" || !/^0[23][0-9a-f]{64}$/.test(v)) throw new Error("owner must be a compressed key");
      tree = tree.replaceConstant(i, SSigmaProp(SGroupElement(hex.decode(v))));
    } else if (name === "CONST_POOL_NFT") {
      if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new Error("poolNft must be 64 hex");
      tree = tree.replaceConstant(i, SColl(SByte, hex.decode(v)));
    } else {
      if (typeof v !== "bigint" || v < 0n || v > 0x7fffffffffffffffn)
        throw new Error(`${TERM_FIELD[name]} out of range`);
      tree = tree.replaceConstant(i, SBigInt(v));
    }
  }
  return tree.toHex();
}

export interface OrderView {
  boxId: string;
  kind: OrderKind;
  terms: OrderTerms;
  /** the owner's P2PK address */
  owner: string;
  value: bigint;
  /** token 0, if any: LIT for swap-buy and deposit, the ownership NFT for redeem */
  token?: { tokenId: string; amount: bigint };
  creationHeight: number;
  ergoTree: string;
}

/**
 * Reads an order box. The template hash picks the kind; the terms are read from the constants; then the tree is
 * rebuilt from those terms and must equal the box's tree byte for byte, so a box that merely shares a template (a
 * constant of another type, an owner that is not a single key) is refused. Returns undefined for anything that is
 * not one of the four order contracts.
 */
export function describeOrder(box: Box<Amount>): OrderView | undefined {
  let tree: ErgoTree;
  let th: string;
  try {
    tree = new ErgoTree(box.ergoTree);
    th = hex.encode(sha256(tree.template));
  } catch {
    return undefined;
  }
  const kind = ORDER_KINDS.find((k) => TEMPLATES[k].templateSha256 === th);
  if (!kind) return undefined;
  const terms: Partial<OrderTerms> = {};
  for (const [name, i] of Object.entries(TEMPLATES[kind].parameters) as [Term, number][]) {
    const c = tree.constants[i];
    const field = TERM_FIELD[name];
    if (name === "CONST_REDEEMER" || name === "CONST_POOL_NFT") {
      if (!(c.data instanceof Uint8Array)) return undefined;
      (terms as Record<string, unknown>)[field] = hex.encode(c.data);
    } else {
      if (typeof c.data !== "bigint") return undefined;
      (terms as Record<string, unknown>)[field] = c.data;
    }
  }
  let rebuilt: string;
  try {
    rebuilt = orderTree(kind, terms as OrderTerms);
  } catch {
    return undefined;
  }
  if (rebuilt !== box.ergoTree) return undefined;
  const t = terms as OrderTerms;
  const token = box.assets[0] ? { tokenId: box.assets[0].tokenId, amount: BigInt(box.assets[0].amount) } : undefined;
  return {
    boxId: box.boxId,
    kind,
    terms: t,
    owner: ErgoAddress.fromPublicKey(t.owner).encode(),
    value: BigInt(box.value),
    token,
    creationHeight: box.creationHeight,
    ergoTree: box.ergoTree,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pool, vault, provision
// ---------------------------------------------------------------------------------------------------------------

export interface PoolView {
  boxId: string;
  /** box value, nanoERG */
  value: bigint;
  /** LIT held, pending fees included */
  litHeld: bigint;
  provisionTokensLeft: bigint;
  /** R4: reserved LP; supply is LOCKED_LP less this */
  liquidity: bigint;
  supply: bigint;
  /** R5: [dexFee, ergFee, tokenFee] over FEE_DENOM */
  feeNum: bigint;
  ergFee: bigint;
  tokenFee: bigint;
  /** R6: fees accrued and not yet flushed */
  pendingX: bigint;
  pendingY: bigint;
  /** what the curve trades with: held less pending */
  reservesX: bigint;
  reservesY: bigint;
  accX: bigint;
  accY: bigint;
}

const reg = <T>(box: Box<Amount>, r: "R4" | "R5" | "R6" | "R7" | "R8"): T => {
  const v = box.additionalRegisters[r];
  if (!v) throw new Error(`box ${box.boxId.slice(0, 8)}… has no ${r}`);
  return SConstant.from<T>(v).data;
};
const asBig = (x: unknown) => BigInt(x as bigint | number | string);

export function describePool(box: Box<Amount>): PoolView {
  if (box.ergoTree !== POOL_TREE) throw new Error("not the LithosDex pool tree");
  if (box.assets.length !== 3 || box.assets[0].tokenId !== POOL_NFT || box.assets[1].tokenId !== LIT)
    throw new Error("pool box must hold the pool NFT, LIT and the provision token");
  const fees = reg<bigint[]>(box, "R5").map(asBig);
  const pending = reg<bigint[]>(box, "R6").map(asBig);
  const liquidity = asBig(reg(box, "R4"));
  const value = BigInt(box.value);
  const litHeld = BigInt(box.assets[1].amount);
  return {
    boxId: box.boxId,
    value,
    litHeld,
    provisionTokensLeft: BigInt(box.assets[2].amount),
    liquidity,
    supply: LOCKED_LP - liquidity,
    feeNum: fees[0],
    ergFee: fees[1],
    tokenFee: fees[2],
    pendingX: pending[0],
    pendingY: pending[1],
    reservesX: value - pending[0],
    reservesY: litHeld - pending[1],
    accX: asBig(reg(box, "R7")),
    accY: asBig(reg(box, "R8")),
  };
}

/**
 * What an order of `amountIn` gets from the pool, as the order contract checks it: the pool sets its side's fee
 * aside (truncated), then the curve with the LP fee, floored. ERG in: LIT units out. LIT in: nanoERG out, before the
 * executor fee.
 */
export function quoteSwap(p: PoolView, ergIn: boolean, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const fee = ergIn ? p.ergFee : p.tokenFee;
  const traded = amountIn - (amountIn * fee) / FEE_DENOM;
  const [rIn, rOut] = ergIn ? [p.reservesX, p.reservesY] : [p.reservesY, p.reservesX];
  return (rOut * traded * p.feeNum) / (rIn * FEE_DENOM + traded * p.feeNum);
}

/** Shares a deposit of `x` nanoERG and `y` LIT units buys (LD_DepositOrder's minimalReward). */
export function depositShares(p: PoolView, x: bigint, y: bigint): bigint {
  const byX = (x * p.supply) / p.reservesX;
  const byY = (y * p.supply) / p.reservesY;
  return byX < byY ? byX : byY;
}

/** ERG and LIT a provision of `shares` takes out on redemption, floored (the pool's redeem rule is a lower bound). */
export function redeemShare(p: PoolView, shares: bigint): { x: bigint; y: bigint } {
  return { x: (shares * p.reservesX) / p.supply, y: (shares * p.reservesY) / p.supply };
}

export interface VaultView {
  boxId: string;
  value: bigint;
  lit: bigint;
  accX: bigint;
  accY: bigint;
  /** ERG it can pay out: everything above VAULT_MIN */
  payableX: bigint;
}

export function describeVault(box: Box<Amount>): VaultView {
  if (box.ergoTree !== VAULT_TREE) throw new Error("not the LithosDex vault tree");
  if (box.assets[0]?.tokenId !== VAULT_NFT || BigInt(box.assets[0].amount) !== 1n) throw new Error("vault NFT missing");
  const value = BigInt(box.value);
  const lit = box.assets[1] ? BigInt(box.assets[1].amount) : 0n;
  if (box.assets[1] && box.assets[1].tokenId !== LIT) throw new Error("vault holds a token other than LIT");
  return {
    boxId: box.boxId,
    value,
    lit,
    accX: asBig(reg(box, "R4")),
    accY: asBig(reg(box, "R5")),
    payableX: value > VAULT_MIN ? value - VAULT_MIN : 0n,
  };
}

export interface ProvisionView {
  boxId: string;
  value: bigint;
  entryX: bigint;
  entryY: bigint;
  /** the token whose holder owns this provision */
  ownerNft: string;
  shares: bigint;
  creationHeight: number;
}

export function describeProvision(box: Box<Amount>): ProvisionView {
  if (box.ergoTree !== PROVISION_GUARD_TREE) throw new Error("not a LithosDex provision box");
  if (box.assets.length !== 1 || box.assets[0].tokenId !== PROVISION_TOKEN || BigInt(box.assets[0].amount) !== 1n)
    throw new Error("a provision box holds exactly one provision token");
  return {
    boxId: box.boxId,
    value: BigInt(box.value),
    entryX: asBig(reg(box, "R4")),
    entryY: asBig(reg(box, "R5")),
    ownerNft: hex.encode(reg<Uint8Array>(box, "R6")),
    shares: asBig(reg(box, "R7")),
    creationHeight: box.creationHeight,
  };
}

/** What the vault owes one provision now (LD_FeeVault's owedX / owedY), and whether the vault would accept a claim. */
export function owed(v: VaultView, p: ProvisionView): { x: bigint; y: bigint; claimable: boolean } {
  const claimable = p.entryX <= v.accX && p.entryY <= v.accY && (p.entryX < v.accX || p.entryY < v.accY);
  return { x: (p.shares * (v.accX - p.entryX)) / SCALE, y: (p.shares * (v.accY - p.entryY)) / SCALE, claimable };
}

// ---------------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------------

interface Common {
  height: number;
  /** the wallet's boxes; Fleet selects what it needs */
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  /** nanoERG the executor keeps, miner fee included (default 0.003 ERG, what the shipped executors accept) */
  executorFee?: bigint;
  /** most of that fee the execution may pay the miner (default 0.001 ERG) */
  maxMinerFee?: bigint;
}

function ownerKey(owner: ErgoAddress): string {
  const keys = owner.getPublicKeys();
  if (keys.length !== 1 || owner.ergoTree !== `0008cd${hex.encode(keys[0])}`)
    throw new Error("the owner must be a P2PK address");
  return hex.encode(keys[0]);
}

function terms(p: Common): OrderTerms {
  const executorFee = p.executorFee ?? DEFAULT_EXECUTOR_FEE;
  const maxMinerFee = p.maxMinerFee ?? DEFAULT_MAX_MINER_FEE;
  if (maxMinerFee < 0n || executorFee <= maxMinerFee)
    throw new Error("the executor fee must be above the most it may spend on the miner fee");
  return { owner: ownerKey(p.owner), poolNft: POOL_NFT, executorFee, maxMinerFee };
}

function place(p: Common, order: OutputBuilder): EIP12UnsignedTransaction {
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .to(order)
    .sendChangeTo(p.owner)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export type SwapDirection = "erg-to-lit" | "lit-to-erg";

export interface SwapOrderParams extends Common {
  /** the pool as last read: checks it is the pool and gives the quote the minimum is compared against */
  poolBox: Box<Amount>;
  direction: SwapDirection;
  /** nanoERG (erg-to-lit) or LIT units (lit-to-erg) sold */
  amountIn: bigint;
  /** fewest LIT units (erg-to-lit), or fewest nanoERG after the executor fee (lit-to-erg) */
  minOut: bigint;
}

/**
 * A swap order. ERG in: the box holds the ERG sold, the executor fee and RETURNED (LDOrderTransactions.swapValue).
 * LIT in: the box holds the LIT and RETURNED. A minimum above the pool's quote is a limit order: it waits until the
 * pool reaches it, or until its owner cancels it.
 */
export function buildSwapOrder(p: SwapOrderParams): EIP12UnsignedTransaction {
  describePool(p.poolBox);
  if (p.amountIn <= 0n) throw new Error("amountIn must be positive");
  if (p.minOut <= 0n) throw new Error("minOut must be positive");
  const t = terms(p);
  if (p.direction === "erg-to-lit") {
    const tree = orderTree("swap-sell", { ...t, baseAmount: p.amountIn, minQuote: p.minOut });
    return place(p, new OutputBuilder(p.amountIn + t.executorFee + RETURNED, tree));
  }
  const tree = orderTree("swap-buy", { ...t, minQuote: p.minOut });
  return place(p, new OutputBuilder(RETURNED, tree).addTokens({ tokenId: LIT, amount: p.amountIn }));
}

export interface DepositOrderParams extends Common {
  poolBox: Box<Amount>;
  /** nanoERG offered to the reserves (the provision box's PROVISION_MIN is added on top) */
  amountX: bigint;
  /** LIT units offered */
  amountY: bigint;
  minShares: bigint;
}

/** A deposit order: amountX + PROVISION_MIN + executor fee + RETURNED, and the LIT (LDOrderTransactions.depositValue). */
export function buildDepositOrder(p: DepositOrderParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  if (pool.provisionTokensLeft <= 0n) throw new Error("the pool has no provision tokens left to hand out");
  if (p.amountX <= 0n || p.amountY <= 0n) throw new Error("both sides of a deposit must be positive");
  if (p.minShares <= 0n) throw new Error("minShares must be positive");
  const t = terms(p);
  const tree = orderTree("deposit", { ...t, depositX: p.amountX, minShares: p.minShares });
  const value = p.amountX + PROVISION_MIN + t.executorFee + RETURNED;
  return place(p, new OutputBuilder(value, tree).addTokens({ tokenId: LIT, amount: p.amountY }));
}

export interface RedeemOrderParams extends Common {
  /** the provision to close; its ownership NFT must be in the wallet's boxes */
  provisionBox: Box<Amount>;
}

/**
 * A redeem order: RETURNED and the provision's ownership NFT. A redemption leaves the provision's unclaimed fees in
 * the vault for good, so claim first (the official client offers to claim in the same transaction; this builder does
 * not).
 */
export function buildRedeemOrder(p: RedeemOrderParams): EIP12UnsignedTransaction {
  const prov = describeProvision(p.provisionBox);
  const t = terms(p);
  const tree = orderTree("redeem", t);
  return place(p, new OutputBuilder(RETURNED, tree).addTokens({ tokenId: prov.ownerNft, amount: 1n }));
}

export interface CancelParams {
  height: number;
  /** the owner's boxes, to pay the fee when the order box cannot */
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  orderBox: Box<Amount>;
}

/**
 * Refunds an order to its owner. Without the pool at input 0 no order contract reads an execution, so the script
 * reduces to the owner's key (its refund path). The fee comes out of the order when what is left still makes a box;
 * otherwise from the owner's boxes. Everything goes to the owner's change.
 */
export function buildCancel(p: CancelParams): EIP12UnsignedTransaction {
  const v = describeOrder(p.orderBox);
  if (!v) throw new Error("not a LithosDex order box");
  if (v.terms.owner !== ownerKey(p.owner)) throw new Error("only the order's owner can cancel it");
  const others = p.inputs.filter((b) => b.boxId !== p.orderBox.boxId);
  return new TransactionBuilder(p.height)
    .from([p.orderBox], { ensureInclusion: true })
    .from(others)
    .sendChangeTo(p.owner)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface ClaimParams {
  height: number;
  /** the owner's boxes: must include a box holding each provision's ownership NFT */
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  vaultBox: Box<Amount>;
  provisionBoxes: Box<Amount>[];
}

/**
 * Settles provisions against the vault (LD_FeeVault op 0, LD_Provision op 0). The vault is input 0 with context
 * variables 0 = op, 1 = how many provisions; provisions follow, each with 0 = op and 64 = the provision logic; then the
 * boxes holding the ownership NFTs, then whatever pays the fee. Outputs mirror the inputs: the vault less exactly
 * what is owed, each provision with its entries moved to the vault's accumulators. What the vault releases lands in
 * the owner's change. Nobody is paid by name: holding the NFT is the right to claim.
 */
export function buildClaim(p: ClaimParams): EIP12UnsignedTransaction {
  const vault = describeVault(p.vaultBox);
  if (p.provisionBoxes.length === 0) throw new Error("a claim settles at least one provision");
  let owedX = 0n;
  let owedY = 0n;
  const provs = p.provisionBoxes.map((b) => {
    const pv = describeProvision(b);
    const o = owed(vault, pv);
    if (!o.claimable)
      throw new Error(`provision ${pv.boxId.slice(0, 8)}… has nothing to settle: the vault has not been flushed since`);
    owedX += o.x;
    owedY += o.y;
    return pv;
  });
  if (owedX > vault.payableX)
    throw new Error(`the vault can pay ${vault.payableX} nanoERG of the ${owedX} owed (${VAULT_MIN} is never paid)`);
  if (owedY > vault.lit) throw new Error(`the vault holds ${vault.lit} LIT units of the ${owedY} owed`);
  const nftBoxes = provs.map((pv) => {
    const holder = p.inputs.find((b) => b.assets.some((a) => a.tokenId === pv.ownerNft));
    if (!holder) throw new Error(`no wallet box holds the ownership NFT ${pv.ownerNft.slice(0, 8)}…`);
    return holder;
  });
  const required = [...new Set(nftBoxes)];
  const rest = p.inputs.filter((b) => !required.includes(b));

  const vaultIn = new ErgoUnsignedInput(p.vaultBox).setContextExtension({
    0: SByte(VAULT_OP.claim),
    1: SInt(provs.length),
  });
  const provIns = p.provisionBoxes.map((b) =>
    new ErgoUnsignedInput(b).setContextExtension({
      0: SByte(PROVISION_OP.claim),
      [PROVISION_LOGIC_VAR]: SColl(SByte, hex.decode(PROVISION_LOGIC)),
    }),
  );
  const vr = p.vaultBox.additionalRegisters;
  const vaultTokens = [{ tokenId: VAULT_NFT, amount: 1n }];
  if (vault.lit - owedY > 0n) vaultTokens.push({ tokenId: LIT, amount: vault.lit - owedY });
  const vaultOut = new OutputBuilder(vault.value - owedX, VAULT_TREE)
    .addTokens(vaultTokens)
    .setAdditionalRegisters({ R4: vr.R4!, R5: vr.R5! });
  const provOuts = p.provisionBoxes.map((b) =>
    new OutputBuilder(BigInt(b.value), PROVISION_GUARD_TREE)
      .addTokens({ tokenId: PROVISION_TOKEN, amount: 1n })
      .setAdditionalRegisters({
        R4: vr.R4!,
        R5: vr.R5!,
        R6: b.additionalRegisters.R6!,
        R7: b.additionalRegisters.R7!,
      }),
  );
  const tx = new TransactionBuilder(p.height)
    .from([vaultIn, ...provIns, ...required] as unknown as Box<Amount>[], { ensureInclusion: true })
    .from(rest)
    .to([vaultOut, ...provOuts])
    .sendChangeTo(p.owner)
    .payFee(FEE)
    .build()
    .toEIP12Object();
  // the vault and provisions find their successors by position
  const ids = [p.vaultBox.boxId, ...p.provisionBoxes.map((b) => b.boxId)];
  ids.forEach((id, i) => {
    if (tx.inputs[i].boxId !== id) throw new Error("claim inputs out of order");
  });
  return tx;
}

// ---------------------------------------------------------------------------------------------------------------
// Direct pool operations: no order, no executor. Each builder below states the contract path it takes.
// ---------------------------------------------------------------------------------------------------------------

export type RefusalCode =
  | "amount" // a non-positive or out-of-range amount
  | "pool-moved" // the pool pays less than the minimum asked
  | "no-provision-tokens" // the pool has no provision token to hand out
  | "min-supply" // the supply would fall below MIN_SUPPLY
  | "same-size" // a resize that changes nothing
  | "zero-size" // a resize to nothing (that is a redemption)
  | "no-owner-nft" // no wallet box holds the provision's ownership NFT
  | "nothing-pending" // a flush with no fees to move
  | "not-old-enough" // a refresh of a provision box younger than REFRESH_AGE
  | "provision-value" // a provision box under PROVISION_MIN (never built by the pool)
  | "order"; // Fleet put the fixed inputs elsewhere than the contracts read them

/** A refusal by one of the direct builders: `code` says which rule, the message says what to do about it. */
export class LithosRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = "LithosRefusal";
    this.code = code;
  }
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

interface PoolNext {
  reservesX: bigint;
  reservesY: bigint;
  pendingX: bigint;
  pendingY: bigint;
  supply: bigint;
  provisionTokens: bigint;
  accX: bigint;
  accY: bigint;
}

/** The pool's successor: value and LIT are reserves plus pending; R5 copied; an unchanged accumulator copied as is. */
function poolSuccessor(box: Box<Amount>, p: PoolView, n: PoolNext): OutputBuilder {
  const r = box.additionalRegisters;
  return new OutputBuilder(n.reservesX + n.pendingX, POOL_TREE)
    .addTokens([
      { tokenId: POOL_NFT, amount: 1n },
      { tokenId: LIT, amount: n.reservesY + n.pendingY },
      { tokenId: PROVISION_TOKEN, amount: n.provisionTokens },
    ])
    .setAdditionalRegisters({
      R4: SLong(LOCKED_LP - n.supply).toHex(),
      R5: r.R5!,
      R6: SColl(SLong, [n.pendingX, n.pendingY]).toHex(),
      R7: n.accX === p.accX ? r.R7! : SBigInt(n.accX).toHex(),
      R8: n.accY === p.accY ? r.R8! : SBigInt(n.accY).toHex(),
    });
}

const unchangedPool = (p: PoolView): PoolNext => ({
  reservesX: p.reservesX,
  reservesY: p.reservesY,
  pendingX: p.pendingX,
  pendingY: p.pendingY,
  supply: p.supply,
  provisionTokens: p.provisionTokensLeft,
  accX: p.accX,
  accY: p.accY,
});

/**
 * The vault's successor on a flush (alone or inside a resize): every pending fee arrives, and the accumulators
 * become the pool's (LD_LiquidityPool op 3 and op 4: `vaultOut.R4 == accX`, value and LIT at least the old plus
 * pending, the LIT entry LIT or absent).
 */
function vaultFlushed(v: VaultView, poolBox: Box<Amount>, p: PoolView): OutputBuilder {
  const lit = v.lit + p.pendingY;
  const tokens = [{ tokenId: VAULT_NFT, amount: 1n }];
  if (lit > 0n) tokens.push({ tokenId: LIT, amount: lit });
  return new OutputBuilder(v.value + p.pendingX, VAULT_TREE)
    .addTokens(tokens)
    .setAdditionalRegisters({ R4: poolBox.additionalRegisters.R7!, R5: poolBox.additionalRegisters.R8! });
}

const poolIn = (box: Box<Amount>, op: number) => new ErgoUnsignedInput(box).setContextExtension({ 0: SByte(op) });
const provisionIn = (box: Box<Amount>, op: number) =>
  new ErgoUnsignedInput(box).setContextExtension({
    0: SByte(op),
    [PROVISION_LOGIC_VAR]: SColl(SByte, hex.decode(PROVISION_LOGIC)),
  });
const vaultFlushIn = (box: Box<Amount>) => new ErgoUnsignedInput(box).setContextExtension({ 0: SByte(VAULT_OP.flush) });

function nftHolder(inputs: Box<Amount>[], pv: ProvisionView): Box<Amount> {
  const holder = inputs.find((b) => b.assets.some((a) => a.tokenId === pv.ownerNft));
  if (!holder)
    throw new LithosRefusal("no-owner-nft", `no wallet box holds the ownership NFT ${pv.ownerNft.slice(0, 8)}…`);
  return holder;
}

/** Builds, then checks the contracts' fixed positions held (Fleet could only move them by reordering the inputs). */
function buildFixed(
  height: number,
  fixed: (ErgoUnsignedInput | Box<Amount>)[],
  rest: Box<Amount>[],
  outputs: OutputBuilder[],
  change: ErgoAddress,
  burn?: { tokenId: string; amount: bigint },
): EIP12UnsignedTransaction {
  const ids = fixed.map((i) => i.boxId);
  const b = new TransactionBuilder(height)
    .from(fixed as unknown as Box<Amount>[], { ensureInclusion: true })
    .from(rest.filter((r) => !ids.includes(r.boxId)))
    .to(outputs)
    .sendChangeTo(change)
    .payFee(FEE);
  if (burn) b.burnTokens(burn);
  const tx = b.build().toEIP12Object();
  ids.forEach((id, i) => {
    if (tx.inputs[i].boxId !== id) throw new LithosRefusal("order", "the pool's fixed inputs moved");
  });
  return tx;
}

export interface DirectSwapParams {
  height: number;
  /** the wallet's boxes; Fleet selects what it needs */
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  poolBox: Box<Amount>;
  direction: SwapDirection;
  /** nanoERG (erg-to-lit) or LIT units (lit-to-erg) paid into the pool, its side fee included */
  amountIn: bigint;
  /** fewest LIT units or nanoERG back; the builder refuses if the pool as read pays less */
  minOut: bigint;
}

/**
 * A swap straight against the pool (LD_LiquidityPool op 0), no order and no executor fee. The whole input enters the
 * box; the side fee (`amountIn * fee / 10000`, truncated) goes to pending and, divided by the supply, onto the
 * accumulator (`fee * 1e27 / supply`, truncated); the rest trades on the curve and the builder takes `quoteSwap`, the
 * most the AMM inequality admits. What the pool pays lands in the change. A pool box spent by anyone else first makes
 * the transaction invalid (rebuild against the new box); it never trades at a worse price than built.
 */
export function buildSwap(p: DirectSwapParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  if (p.amountIn <= 0n) throw new LithosRefusal("amount", "amountIn must be positive");
  if (p.minOut <= 0n) throw new LithosRefusal("amount", "minOut must be positive");
  const ergIn = p.direction === "erg-to-lit";
  const fee = (p.amountIn * (ergIn ? pool.ergFee : pool.tokenFee)) / FEE_DENOM;
  const out = quoteSwap(pool, ergIn, p.amountIn);
  if (out < p.minOut)
    throw new LithosRefusal("pool-moved", `the pool pays ${out} now, below the ${p.minOut} asked: rebuild or lower it`);
  const advance = (fee * SCALE) / pool.supply;
  const next = unchangedPool(pool);
  if (ergIn) {
    next.reservesX += p.amountIn - fee;
    next.pendingX += fee;
    next.accX += advance;
    next.reservesY -= out;
  } else {
    next.reservesY += p.amountIn - fee;
    next.pendingY += fee;
    next.accY += advance;
    next.reservesX -= out;
  }
  if (next.reservesX <= 0n || next.reservesY <= 0n || next.reservesX + next.pendingX <= POOL_MIN_VALUE)
    throw new LithosRefusal("amount", "the pool cannot pay that much");
  return buildFixed(
    p.height,
    [poolIn(p.poolBox, POOL_OP.swap)],
    p.inputs,
    [poolSuccessor(p.poolBox, pool, next)],
    p.owner,
  );
}

/** The cheapest deposit for `shares` (LDLiquidityPool.simDepositForShares): both sides rounded up. */
export function depositCost(p: PoolView, shares: bigint): { x: bigint; y: bigint } {
  return { x: ceilDiv(shares * p.reservesX, p.supply), y: ceilDiv(shares * p.reservesY, p.supply) };
}

export interface DirectDepositParams {
  height: number;
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  poolBox: Box<Amount>;
  /** LP shares to open; the cheapest ERG and LIT for them are taken (depositCost) */
  shares: bigint;
}

/**
 * Opens a provision straight against the pool (LD_LiquidityPool op 1). Outputs: the pool with `depositCost` added and
 * one provision token fewer; the provision box (PROVISION_MIN, one provision token, R4/R5 the pool's accumulators,
 * R6 the pool box's id, R7 the shares); the ownership NFT, minted from the pool box's id (the pool is input 0, which
 * is what makes the id unmintable anywhere else), in a box of OWNER_BOX_VALUE to the owner with the official client's
 * EIP-4 registers. The wallet pays the two sides, PROVISION_MIN, OWNER_BOX_VALUE (it comes back with the NFT) and the
 * fee. The provision enters at the pool's accumulators, so it is owed nothing until a swap after it is flushed.
 */
export function buildDeposit(p: DirectDepositParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  if (p.shares <= 0n) throw new LithosRefusal("amount", "a deposit opens at least one share");
  if (pool.provisionTokensLeft <= 1n)
    throw new LithosRefusal("no-provision-tokens", "the pool has no provision tokens left to hand out");
  const { x, y } = depositCost(pool, p.shares);
  const next = unchangedPool(pool);
  next.reservesX += x;
  next.reservesY += y;
  next.supply += p.shares;
  next.provisionTokens -= 1n;
  const nft = p.poolBox.boxId;
  const r = p.poolBox.additionalRegisters;
  const provision = new OutputBuilder(PROVISION_MIN, PROVISION_GUARD_TREE)
    .addTokens({ tokenId: PROVISION_TOKEN, amount: 1n })
    .setAdditionalRegisters({
      R4: r.R7!,
      R5: r.R8!,
      R6: SColl(SByte, hex.decode(nft)).toHex(),
      R7: SLong(p.shares).toHex(),
    });
  // LithosDexTransactions.provisionNftDescription: the provision as it opened, for a wallet to show
  const description =
    `{"type":"LithosDex Provision","pool":"${POOL_NFT}","tokenY":"${LIT}","provisionToken":"${PROVISION_TOKEN}",` +
    `"R4_entryX":"${pool.accX}","R5_entryY":"${pool.accY}","R6_ownerNFT":"${nft}","R7_shares":${p.shares},` +
    `"depositedX":${x},"depositedY":${y},"height":${p.height}}`;
  const owner = new OutputBuilder(OWNER_BOX_VALUE, p.owner).mintToken({
    amount: 1n,
    name: `LD-NFT-${nft.slice(0, 6)}`,
    description,
    decimals: 0,
  });
  const tx = buildFixed(
    p.height,
    [poolIn(p.poolBox, POOL_OP.deposit)],
    p.inputs,
    [poolSuccessor(p.poolBox, pool, next), provision, owner],
    p.owner,
  );
  if (tx.outputs[2].assets[0]?.tokenId !== nft)
    throw new LithosRefusal("order", "the NFT was not minted from the pool");
  return tx;
}

export interface DirectRedeemParams {
  height: number;
  /** the owner's boxes: one must hold the provision's ownership NFT */
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  poolBox: Box<Amount>;
  provisionBox: Box<Amount>;
}

/**
 * Closes a provision straight against the pool (LD_LiquidityPool op 2, LD_Provision op 1): the pool at input 0, the
 * provision at 1, the NFT's box after. The pool releases `shares * reserves / supply` of each side, floored (the most
 * its rule admits) and takes the provision token home; the payout (output 1, which the provision logic reads as its
 * successor slot) carries that ERG plus the provision box's value, and the LIT; the NFT is burned. Unclaimed fees stay
 * in the vault for good, so claim first.
 */
export function buildRedeem(p: DirectRedeemParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  const pv = describeProvision(p.provisionBox);
  if (pool.supply - pv.shares < MIN_SUPPLY)
    throw new LithosRefusal("min-supply", `closing ${pv.shares} shares would take the supply under ${MIN_SUPPLY}`);
  const holder = nftHolder(p.inputs, pv);
  const { x, y } = redeemShare(pool, pv.shares);
  const next = unchangedPool(pool);
  next.reservesX -= x;
  next.reservesY -= y;
  next.supply -= pv.shares;
  next.provisionTokens += 1n;
  const payout = new OutputBuilder(x + pv.value, p.owner);
  if (y > 0n) payout.addTokens({ tokenId: LIT, amount: y });
  return buildFixed(
    p.height,
    [poolIn(p.poolBox, POOL_OP.redeem), provisionIn(p.provisionBox, PROVISION_OP.redeem), holder],
    p.inputs,
    [poolSuccessor(p.poolBox, pool, next), payout],
    p.owner,
    { tokenId: pv.ownerNft, amount: 1n },
  );
}

export interface FlushParams {
  height: number;
  /** the payer's boxes, for the fee */
  inputs: Box<Amount>[];
  /** pays the fee and takes the change; anyone */
  owner: ErgoAddress;
  poolBox: Box<Amount>;
  vaultBox: Box<Amount>;
}

/**
 * Moves the pool's pending fees into the vault (LD_LiquidityPool op 3, LD_FeeVault op 1). Permissionless: neither
 * script reads a key, and the caller is paid nothing; it turns fees the vault cannot pay yet into fees a claim can
 * take. Outputs: the pool less exactly its pending, R6 zeroed; the vault plus exactly that, its R4/R5 set to the
 * pool's accumulators. The pool refuses a flush with nothing pending.
 */
export function buildFlush(p: FlushParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  const vault = describeVault(p.vaultBox);
  if (pool.pendingX <= 0n && pool.pendingY <= 0n)
    throw new LithosRefusal("nothing-pending", "nothing is pending: the pool refuses a flush that moves nothing");
  const next = { ...unchangedPool(pool), pendingX: 0n, pendingY: 0n };
  return buildFixed(
    p.height,
    [poolIn(p.poolBox, POOL_OP.flush), vaultFlushIn(p.vaultBox)],
    p.inputs,
    [poolSuccessor(p.poolBox, pool, next), vaultFlushed(vault, p.poolBox, pool)],
    p.owner,
  );
}

export interface ResizeQuote {
  delta: bigint;
  /** nanoERG and LIT units the wallet pays in (delta > 0) or takes out (delta < 0) */
  x: bigint;
  y: bigint;
  /** the entries the resized provision must carry: what it was owed is preserved, rounded down */
  entryX: bigint;
  entryY: bigint;
}

/** LDLiquidityPool.simResize: growing rounds both sides up, shrinking down; the entry keeps `shares * (acc - entry)`. */
export function resizeQuote(p: PoolView, pv: ProvisionView, newShares: bigint): ResizeQuote {
  const delta = newShares - pv.shares;
  const grow = delta > 0n;
  const x = grow ? ceilDiv(delta * p.reservesX, p.supply) : (-delta * p.reservesX) / p.supply;
  const y = grow ? ceilDiv(delta * p.reservesY, p.supply) : (-delta * p.reservesY) / p.supply;
  return {
    delta,
    x,
    y,
    entryX: p.accX - (pv.shares * (p.accX - pv.entryX)) / newShares,
    entryY: p.accY - (pv.shares * (p.accY - pv.entryY)) / newShares,
  };
}

export interface ResizeParams {
  height: number;
  /** the owner's boxes: one must hold the provision's ownership NFT */
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  poolBox: Box<Amount>;
  vaultBox: Box<Amount>;
  provisionBox: Box<Amount>;
  /** the provision's new size in shares: positive and different from the current one */
  newShares: bigint;
}

/**
 * Changes a provision's size without closing it (LD_LiquidityPool op 4, LD_Provision op 3, LD_FeeVault op 1): the
 * pool at input 0, the provision at 1, the vault at 2, the NFT's box after; successors at the same indices. Growing
 * pays `resizeQuote` into the reserves, shrinking takes it out to the change. The provision keeps its value, token
 * and NFT; R7 becomes the new size and R4/R5 the entries that keep what it had earned (so a resize settles without
 * paying out, and needs no claim first). The same transaction flushes: the pool's pending fees go to the vault with
 * its accumulators, which the pool requires so the new entries are right against the vault too. Owner only: the
 * provision logic requires the NFT among the inputs.
 */
export function buildResize(p: ResizeParams): EIP12UnsignedTransaction {
  const pool = describePool(p.poolBox);
  const vault = describeVault(p.vaultBox);
  const pv = describeProvision(p.provisionBox);
  if (p.newShares <= 0n)
    throw new LithosRefusal("zero-size", "a provision cannot be resized to nothing: redeem it instead");
  if (p.newShares === pv.shares) throw new LithosRefusal("same-size", `the provision already has ${pv.shares} shares`);
  if (pv.value < PROVISION_MIN)
    throw new LithosRefusal("provision-value", `the provision box holds less than ${PROVISION_MIN} nanoERG`);
  const q = resizeQuote(pool, pv, p.newShares);
  if (pool.supply + q.delta < MIN_SUPPLY)
    throw new LithosRefusal("min-supply", `this resize would take the supply under ${MIN_SUPPLY}`);
  const holder = nftHolder(p.inputs, pv);
  const sign = q.delta > 0n ? 1n : -1n;
  const next = {
    ...unchangedPool(pool),
    reservesX: pool.reservesX + sign * q.x,
    reservesY: pool.reservesY + sign * q.y,
    pendingX: 0n,
    pendingY: 0n,
    supply: pool.supply + q.delta,
  };
  if (next.reservesX <= 0n || next.reservesY <= 0n) throw new LithosRefusal("amount", "the pool cannot release that");
  const pr = p.provisionBox.additionalRegisters;
  const provision = new OutputBuilder(pv.value, PROVISION_GUARD_TREE)
    .addTokens({ tokenId: PROVISION_TOKEN, amount: 1n })
    .setAdditionalRegisters({
      R4: q.entryX === pool.accX ? p.poolBox.additionalRegisters.R7! : SBigInt(q.entryX).toHex(),
      R5: q.entryY === pool.accY ? p.poolBox.additionalRegisters.R8! : SBigInt(q.entryY).toHex(),
      R6: pr.R6!,
      R7: SLong(p.newShares).toHex(),
    });
  return buildFixed(
    p.height,
    [
      poolIn(p.poolBox, POOL_OP.resize),
      provisionIn(p.provisionBox, PROVISION_OP.resize),
      vaultFlushIn(p.vaultBox),
      holder,
    ],
    p.inputs,
    [poolSuccessor(p.poolBox, pool, next), provision, vaultFlushed(vault, p.poolBox, pool)],
    p.owner,
  );
}

export interface RefreshParams {
  height: number;
  /** the payer's boxes, for the fee */
  inputs: Box<Amount>[];
  /** pays the fee; anyone, the provision's owner or not */
  owner: ErgoAddress;
  provisionBox: Box<Amount>;
}

/** The first height at which a provision box created at `creationHeight` may be refreshed. */
export const refreshableAt = (creationHeight: number) => creationHeight + REFRESH_AGE + 1;

/**
 * Re-creates a provision box unchanged so storage rent cannot reach it (LD_Provision op 2). Permissionless, once the
 * box was created more than REFRESH_AGE (525600, about two years) blocks before the spending block; the successor
 * (output 0, the provision being input 0) is the same box with `height` as its creation height, which must be within
 * HEIGHT_SLACK of the spending block. The builder refuses before `refreshableAt`: the logic would reduce to false.
 */
export function buildRefresh(p: RefreshParams): EIP12UnsignedTransaction {
  const pv = describeProvision(p.provisionBox);
  if (p.height < refreshableAt(pv.creationHeight))
    throw new LithosRefusal(
      "not-old-enough",
      `the provision box was created at ${pv.creationHeight}: it can be refreshed from height ${refreshableAt(pv.creationHeight)}`,
    );
  const r = p.provisionBox.additionalRegisters;
  const successor = new OutputBuilder(pv.value, PROVISION_GUARD_TREE)
    .addTokens({ tokenId: PROVISION_TOKEN, amount: 1n })
    .setAdditionalRegisters({ R4: r.R4!, R5: r.R5!, R6: r.R6!, R7: r.R7! });
  return buildFixed(p.height, [provisionIn(p.provisionBox, PROVISION_OP.refresh)], p.inputs, [successor], p.owner);
}

// ---------------------------------------------------------------------------------------------------------------
// What the signer needs to know
// ---------------------------------------------------------------------------------------------------------------

export interface SignerHints {
  /** output scripts that are neither the owner, the fee contract nor an input's own script (a signer's --allow-tree) */
  allowTrees: string[];
  /** input scripts, other than the owner's P2PK, that reduce to the owner's key on this spend (a signer's --sign-tree) */
  signTrees: string[];
  /** indices of inputs under ErgoTree version 2 or later: the signing library must parse these */
  v3Inputs: number[];
}

/** ErgoTree version from the header's low three bits. */
export function treeVersion(tree: string): number {
  return parseInt(tree.slice(0, 2), 16) & 0x07;
}

export function signerHints(tx: EIP12UnsignedTransaction, owner: ErgoAddress): SignerHints {
  const inputTrees = new Set(tx.inputs.map((i) => i.ergoTree));
  const allowTrees = [
    ...new Set(
      tx.outputs.map((o) => o.ergoTree).filter((t) => t !== owner.ergoTree && t !== FEE_CONTRACT && !inputTrees.has(t)),
    ),
  ];
  const key = ownerKey(owner);
  const signTrees = [
    ...new Set(
      tx.inputs
        .filter((i) => i.ergoTree !== owner.ergoTree && describeOrder(i)?.terms.owner === key)
        .map((i) => i.ergoTree),
    ),
  ];
  const v3Inputs = tx.inputs.flatMap((i, k) => (treeVersion(i.ergoTree) >= 2 ? [k] : []));
  return { allowTrees, signTrees, v3Inputs };
}
