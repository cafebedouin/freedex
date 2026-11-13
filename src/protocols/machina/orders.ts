// Pure transaction builders for Machina E2T limit orders. No DOM, no wallet, no network: testable on a mock chain.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { ErgoAddress, TransactionBuilder, type R4ToR6Registers } from "@fleet-sdk/core";
import { SConstant } from "@fleet-sdk/serializer";
import { LimitOrder } from "@nautls/machinafi-sdk";
import { contract, fillTemplate } from "../../registry.ts";

/** The miner fee: the node's default minimum (0.001 ERG), the only fee the page adds to any transaction. */
export const FEE = 1_000_000n;

export type OrderBox = Box<Amount, R4ToR6Registers>;

/**
 * The SDK's contract interface, which `LimitOrder` takes as an optional second argument: the tree for a token, the
 * token read back from a tree, and the check that a tree is this contract for some token.
 */
type SdkContract = NonNullable<ConstructorParameters<typeof LimitOrder>[1]>;

const TOKEN_ID = /^[0-9a-f]{64}$/;

/**
 * Machina's ErgoTree version 2 limit order (src/registry.json "machina-e2t-limit-order-v2"), the tree live Machina
 * orders carry; @nautls/machinafi-sdk 0.1.0 builds only the version-1 tree. Same registers, same constants, the token
 * id at the same offset; the SDK's fill and close outputs satisfy it (test/machina-v2.test.ts against recorded spends).
 * A wallet signs a close of one only if its library reads version 2 (ergo-lib-wasm 0.29; 0.28 cannot).
 */
export const E2T_V2: SdkContract = (() => {
  const template = contract("machina-e2t-limit-order-v2").template!;
  const offset = template.indexOf("{tokenId}");
  const tree = (tokenId: string) => fillTemplate("machina-e2t-limit-order-v2", { tokenId });
  return {
    type: "E2T",
    new(tokenId: string) {
      if (!TOKEN_ID.test(tokenId)) throw new Error("Invalid quote token ID");
      return tree(tokenId);
    },
    getQuoteId(proposition: string) {
      return proposition.substring(offset, offset + 64);
    },
    validate(proposition: string) {
      const id = proposition.substring(offset, offset + 64);
      return TOKEN_ID.test(id) && proposition === tree(id);
    },
  } as unknown as SdkContract;
})();

/** The order's contract: the version-2 tree, or undefined for the SDK's own (version 1). */
export function contractOf(box: Box<Amount>): SdkContract | undefined {
  return E2T_V2.validate(box.ergoTree) ? E2T_V2 : undefined;
}

/** A LimitOrder over either tree. */
function limitOrder(box: Box<Amount>): LimitOrder {
  return new LimitOrder(asOrderBox(box), contractOf(box));
}

/** An order box must carry R4 (owner), R5 (price) and R6 (side); anything else is not an order. */
export function asOrderBox(box: Box<Amount>): OrderBox {
  const r = box.additionalRegisters;
  if (!r.R4 || !r.R5 || !r.R6) throw new Error(`box ${box.boxId} lacks R4-R6`);
  return box as OrderBox;
}

/**
 * The owner's side of an order. The SDK and the contract name orders by the taker's action
 * (R6 true: takers buy tokens from the box; R6 false: takers sell tokens into it), so an owner
 * who sells tokens creates a "buy" order and an owner who buys tokens creates a "sell" order.
 */
export type OwnerSide = "sell-tokens" | "buy-tokens";

export interface CreateParams {
  height: number;
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  side: OwnerSide;
  quoteTokenId: string;
  /** nanoERG per smallest token unit */
  price: bigint;
  /** tokens offered (side "sell-tokens"), in smallest units */
  tokenAmount?: bigint;
  /** ERG budget (side "buy-tokens"), in nanoERG */
  ergAmount?: bigint;
  /** the contract's ErgoTree version: 1 (the SDK's, the default) or 2 (Machina's live tree, E2T_V2) */
  treeVersion?: 1 | 2;
}

export function buildCreate(p: CreateParams): EIP12UnsignedTransaction {
  const c = p.treeVersion === 2 ? E2T_V2 : undefined;
  const order =
    p.side === "sell-tokens"
      ? LimitOrder.create(
          {
            owner: p.owner,
            type: "buy",
            price: p.price,
            assets: {
              base: { tokenId: "ERG", amount: 0n },
              quote: { tokenId: p.quoteTokenId, amount: required(p.tokenAmount, "tokenAmount") },
            },
          },
          c,
        )
      : LimitOrder.create(
          {
            owner: p.owner,
            type: "sell",
            price: p.price,
            assets: {
              base: { tokenId: "ERG", amount: required(p.ergAmount, "ergAmount") },
              quote: { tokenId: p.quoteTokenId, amount: 0n },
            },
          },
          c,
        );

  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .to(order)
    .sendChangeTo(p.owner)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface FillParams {
  height: number;
  inputs: Box<Amount>[];
  taker: ErgoAddress;
  orderBox: Box<Amount>;
  /** tokens to buy from, or sell into, the order, in smallest units */
  tokenAmount: bigint;
}

/** The taker buys tokens (pays ERG) from a "buy" order, or sells tokens (receives ERG) into a "sell" order. */
export function buildFill(p: FillParams): EIP12UnsignedTransaction {
  const order = limitOrder(p.orderBox);
  const action = takerAction(p.orderBox) === "buy" ? order.buy(p.tokenAmount) : order.sell(p.tokenAmount);
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .extend(action)
    .sendChangeTo(p.taker)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export interface CloseParams {
  height: number;
  /** the owner's boxes, to pay the fee when the order box cannot */
  inputs: Box<Amount>[];
  owner: ErgoAddress;
  orderBox: Box<Amount>;
}

export function buildClose(p: CloseParams): EIP12UnsignedTransaction {
  const order = limitOrder(p.orderBox);
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .extend(order.close())
    .sendChangeTo(p.owner)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export type TakerAction = "buy" | "sell";

export interface OrderView {
  boxId: string;
  takerAction: TakerAction;
  /** nanoERG per smallest token unit */
  price: bigint;
  tokenId: string;
  /** tokens held by the order (what takers can buy), smallest units */
  tokenAmount: bigint;
  /** nanoERG held by the order (what takers can be paid from) */
  value: bigint;
  owner: string;
  creationHeight: number;
}

export function takerAction(box: Box<Amount>): TakerAction {
  const r6 = box.additionalRegisters.R6;
  if (!r6) throw new Error("order box has no R6");
  return SConstant.from<boolean>(r6).data ? "buy" : "sell";
}

export function describe(box: Box<Amount>): OrderView {
  const ob = asOrderBox(box);
  const order = limitOrder(ob);
  const ownerPk = SConstant.from<Uint8Array>(ob.additionalRegisters.R4).data;
  return {
    boxId: box.boxId,
    takerAction: takerAction(box),
    price: order.price,
    tokenId: order.assets.quote.tokenId,
    tokenAmount: order.assets.quote.amount,
    value: BigInt(box.value),
    owner: ErgoAddress.fromPublicKey(ownerPk).encode(),
    creationHeight: box.creationHeight,
  };
}

/** How many tokens a taker can still buy from, or sell into, this order at its price. */
export function capacity(v: OrderView): bigint {
  return v.takerAction === "buy" ? v.tokenAmount : v.value / v.price;
}

function required(x: bigint | undefined, name: string): bigint {
  if (x === undefined || x <= 0n) throw new Error(`${name} must be a positive amount`);
  return x;
}
