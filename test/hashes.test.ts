// The template hashes the explorer queries use are pinned to the trees the builders use.
import { describe, expect, it } from "vitest";
import { ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import { POOL_TREE, T2T_POOL_TREE } from "../src/amm";
import { BABEL_TEMPLATE_SHA256 as BABEL_IN_BABEL, babelTree } from "../src/babel";
import { BABEL_TEMPLATE_SHA256, E2T_LIMIT_TEMPLATE_SHA256, POOL_TEMPLATE_SHA256, T2T_POOL_TEMPLATE_SHA256 } from "../src/explorer";
import { LimitOrder } from "@nautls/machinafi-sdk";
import { ErgoAddress } from "@fleet-sdk/core";
import { bondContract, orderContract, SIGMAFI_TEMPLATES } from "../src/bonds";

const h = (tree: string) => hex.encode(sha256(new ErgoTree(tree).template));

describe("template hashes match their trees", () => {
  it("ERG pool", () => expect(h(POOL_TREE)).toBe(POOL_TEMPLATE_SHA256));
  it("token-to-token pool", () => expect(h(T2T_POOL_TREE)).toBe(T2T_POOL_TEMPLATE_SHA256));
  it("Babel, the same for any token", () => {
    expect(h(babelTree("00".repeat(32)))).toBe(BABEL_TEMPLATE_SHA256);
    expect(BABEL_IN_BABEL).toBe(BABEL_TEMPLATE_SHA256);
  });
  it("Machina E2T limit order", () => {
    const owner = ErgoAddress.fromBase58("9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA");
    const tree = LimitOrder.create({ owner, type: "buy", price: 1n, assets: { base: { tokenId: "ERG", amount: 0n }, quote: { tokenId: "11".repeat(32), amount: 1n } } }).ergoTree;
    expect(h(tree)).toBe(E2T_LIMIT_TEMPLATE_SHA256);
  });
  it("SigmaFi orders and bonds", () => {
    expect(h(orderContract("ERG"))).toBe(SIGMAFI_TEMPLATES.orderOnCloseErg);
    expect(h(orderContract("22".repeat(32)))).toBe(SIGMAFI_TEMPLATES.orderOnCloseToken);
    expect(h(bondContract("ERG"))).toBe(SIGMAFI_TEMPLATES.bondErg);
    expect(h(bondContract("22".repeat(32)))).toBe(SIGMAFI_TEMPLATES.bondToken);
  });
});
