// src/registry.json is the single source for every tree and template hash the page builds against. Every entry's
// hash must be the SHA-256 of its tree's template; a template's placeholders are segregated constants, so any
// filling hashes the same; the SDK-built order must hash to its entry; and the contracts whose source is in
// contracts/ must compile to the bytes pinned here.
import { describe, expect, it } from "vitest";
import { ErgoAddress, ErgoTree } from "@fleet-sdk/core";
import { hex, sha256 } from "@fleet-sdk/crypto";
import { compile } from "@fleet-sdk/compiler";
import { LimitOrder } from "@nautls/machinafi-sdk";
import { REGISTRY, fillTemplate } from "../src/registry";
import { POOL_TEMPLATE_SHA256, POOL_TREE, T2T_POOL_TEMPLATE_SHA256, T2T_POOL_TREE } from "../src/protocols/ergodex/amm";
import { BABEL_TEMPLATE_SHA256 as BABEL_IN_BABEL, babelTree } from "../src/protocols/babel/babel";
import {
  BABEL_TEMPLATE_SHA256,
  E2T_LIMIT_TEMPLATE_SHA256,
  POOL_TEMPLATE_SHA256 as POOL_IN_EXPLORER,
  T2T_POOL_TEMPLATE_SHA256 as T2T_IN_EXPLORER,
} from "../src/explorer";
import { SIGMAFI_TEMPLATES, bondContract, orderContract } from "../src/protocols/sigmafi/bonds";
import { CLOCK_SELL_TREE, CLOCK_SLACK, CLOCK_TREE } from "../src/protocols/clock/clock";
import { CALL_TREE, PUT_TREE } from "../src/protocols/option/option";
import CLOCK_SOURCE from "../contracts/Clock.es?raw";
import CLOCK_SELL_SOURCE from "../contracts/ClockSell.es?raw";
import CALL_SOURCE from "../contracts/Call.es?raw";
import PUT_SOURCE from "../contracts/Put.es?raw";

const h = (tree: string) => hex.encode(sha256(new ErgoTree(tree).template));
const ids = Object.keys(REGISTRY);

describe("the registry: every entry's hash is the SHA-256 of its template", () => {
  it("has the eighteen entries the page builds against, each on mainnet with a 64-hex hash", () => {
    expect(ids.length).toBe(18);
    for (const id of ids) {
      const e = REGISTRY[id];
      expect(e.network, id).toBe("mainnet");
      expect(e.templateSha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(e.licence, id).toBeTruthy();
    }
  });
  it.each(ids.filter((id) => REGISTRY[id].tree))("%s: fixed tree", (id) => {
    expect(h(REGISTRY[id].tree!)).toBe(REGISTRY[id].templateSha256);
  });
  it.each(ids.filter((id) => REGISTRY[id].template))("%s: template, any filling", (id) => {
    const e = REGISTRY[id];
    const names = [...e.template!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    expect(Object.keys(e.placeholders ?? {}).sort()).toEqual([...new Set(names)].sort());
    for (const byte of ["00", "7f", "ff"]) {
      const vars = Object.fromEntries(names.map((n) => [n, byte.repeat(32)]));
      expect(h(fillTemplate(id, vars))).toBe(e.templateSha256);
    }
    expect(() => fillTemplate(id, {})).toThrow(/needs/);
  });
  it("machina-e2t-limit-order: the SDK builds the sample tree and every order shares its template", () => {
    const e = REGISTRY["machina-e2t-limit-order"];
    const owner = ErgoAddress.fromBase58("9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA");
    const sample = LimitOrder.create({
      owner,
      type: "buy",
      price: 1n,
      assets: { base: { tokenId: "ERG", amount: 0n }, quote: { tokenId: "11".repeat(32), amount: 1n } },
    }).ergoTree;
    expect(sample).toBe(e.sampleTree);
    expect(h(sample)).toBe(e.templateSha256);
    const other = LimitOrder.create({
      owner: ErgoAddress.fromBase58("9gnBiuBAy4GgGEk1MZQ5f7aWWuQnyGHNVVF4bvhHKWvecWTNcfc"),
      type: "sell",
      price: 123_456n,
      assets: { base: { tokenId: "ERG", amount: 5_000_000n }, quote: { tokenId: "ab".repeat(32), amount: 0n } },
    }).ergoTree;
    expect(h(other)).toBe(e.templateSha256);
  });
});

describe("the modules read the registry", () => {
  it("pool, Babel and order hashes are the registry's wherever they are exported", () => {
    expect(h(POOL_TREE)).toBe(POOL_TEMPLATE_SHA256);
    expect(POOL_IN_EXPLORER).toBe(POOL_TEMPLATE_SHA256);
    expect(h(T2T_POOL_TREE)).toBe(T2T_POOL_TEMPLATE_SHA256);
    expect(T2T_IN_EXPLORER).toBe(T2T_POOL_TEMPLATE_SHA256);
    expect(h(babelTree("00".repeat(32)))).toBe(BABEL_TEMPLATE_SHA256);
    expect(BABEL_IN_BABEL).toBe(BABEL_TEMPLATE_SHA256);
    expect(E2T_LIMIT_TEMPLATE_SHA256).toBe(REGISTRY["machina-e2t-limit-order"].templateSha256);
  });
  it("SigmaFi orders and bonds, ERG and token principal", () => {
    expect(h(orderContract("ERG"))).toBe(SIGMAFI_TEMPLATES.orderOnCloseErg);
    expect(h(orderContract("22".repeat(32)))).toBe(SIGMAFI_TEMPLATES.orderOnCloseToken);
    expect(h(bondContract("ERG"))).toBe(SIGMAFI_TEMPLATES.bondErg);
    expect(h(bondContract("22".repeat(32)))).toBe(SIGMAFI_TEMPLATES.bondToken);
    expect(SIGMAFI_TEMPLATES.orderOnCloseErg).toBe(REGISTRY["sigmafi-order-on-close-erg"].templateSha256);
    expect(SIGMAFI_TEMPLATES.bondToken).toBe(REGISTRY["sigmafi-bond-token"].templateSha256);
  });
});

describe("this project's contracts compile to the pinned bytes", () => {
  // the same compile as scripts/compile-clock.ts: ErgoTree v1, segregated constants, SLACK substituted
  const compiled = (source: string) =>
    compile(source.replace(/\$SLACK/g, String(CLOCK_SLACK)), { version: 1, segregateConstants: true }).toHex();
  // the same compile as scripts/compile-option.ts: no substitution
  const compiledPlain = (source: string) => compile(source, { version: 1, segregateConstants: true }).toHex();
  it("contracts/Clock.es is clock-buy", () => {
    expect(compiled(CLOCK_SOURCE)).toBe(REGISTRY["clock-buy"].tree);
    expect(CLOCK_TREE).toBe(REGISTRY["clock-buy"].tree);
  });
  it("contracts/ClockSell.es is clock-sell", () => {
    expect(compiled(CLOCK_SELL_SOURCE)).toBe(REGISTRY["clock-sell"].tree);
    expect(CLOCK_SELL_TREE).toBe(REGISTRY["clock-sell"].tree);
    expect(REGISTRY["clock-sell"].templateSha256).not.toBe(REGISTRY["clock-buy"].templateSha256);
  });
  it("contracts/Call.es is option-call", () => {
    expect(compiledPlain(CALL_SOURCE)).toBe(REGISTRY["option-call"].tree);
    expect(CALL_TREE).toBe(REGISTRY["option-call"].tree);
  });
  it("contracts/Put.es is option-put", () => {
    expect(compiledPlain(PUT_SOURCE)).toBe(REGISTRY["option-put"].tree);
    expect(PUT_TREE).toBe(REGISTRY["option-put"].tree);
    expect(REGISTRY["option-put"].templateSha256).not.toBe(REGISTRY["option-call"].templateSha256);
  });
  it("every entry whose source is in contracts/ was compiled above", () => {
    const own = ids.filter((id) => REGISTRY[id].source.repository === "https://github.com/cafebedouin/freedex");
    expect(own.sort()).toEqual(["clock-buy", "clock-sell", "option-call", "option-put"]);
  });
});
