// The option as a timed escrow against its compiled trees on the mock chain: the preregistered cases of
// skunks/option/CHARTER.md for the call (Call.es), then the same mirrored for the put (Put.es).
// The mock chain evaluates at HEIGHT = chain.height + 1, as a node checks the next block, so "at the expiry" means
// chain.height = expiry - 1, and "at expiry + 1" means chain.height = expiry. The builders refuse one block earlier
// than the script does (a buy or exercise while height < expiry; a reclaim once height >= expiry), so the cases at
// the edges force the transaction past the builder's own guard.
import { BLOCKCHAIN_PARAMETERS, MockChain, mockBlockchainStateContext } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { ErgoTree } from "@fleet-sdk/core";
import { SByte, SColl, SGroupElement, SInt, SSigmaProp } from "@fleet-sdk/serializer";
import { ErgoUnsignedInput, OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import sigma from "sigmastate-js/main";
import { OWNER_BOX_VALUE, RENT_PERIOD, STORAGE_FEE_FACTOR } from "../clock/clock";
import {
  CALL_TREE,
  PUT_TREE,
  buildBuy,
  buildCancelUnsold,
  buildExercise,
  buildReclaim,
  buildWrite,
  canBuy,
  canExercise,
  canReclaim,
  describeOption,
  sizeWrite,
  type OptionSide,
} from "./option";
import { FEE } from "../machina/orders";

const TOKEN = "44".repeat(32);
const ERG = 1_000_000_000n;
const AMOUNT = 9n;
const STRIKE = 30_000n; // nanoERG per unit
const PREMIUM = 1_000_000n;
const TERM = 30; // blocks to the expiry

/** The JIT cost sigmastate-js reports for one input's script in a transaction. */
function scriptCost(chain: MockChain, tx: EIP12UnsignedTransaction, input: number): number {
  const ctx = mockBlockchainStateContext({
    headers: { quantity: 10, fromHeight: chain.height, fromTimestamp: Date.now() },
  });
  const { ProverBuilder$ } = sigma as unknown as {
    ProverBuilder$: {
      create(
        p: unknown,
        n: number,
      ): { build(): { reduceTransactionInput(...a: unknown[]): { reductionResult: { cost: number } } } };
    };
  };
  const prover = ProverBuilder$.create(BLOCKCHAIN_PARAMETERS, 0).build();
  return prover.reduceTransactionInput(ctx, tx, tx.inputs, tx.dataInputs, [], input).reductionResult.cost;
}

/** The input index of the option box in a built transaction. */
const optionIndex = (tx: EIP12UnsignedTransaction, tree: string) => tx.inputs.findIndex((i) => i.ergoTree === tree);

function suite(side: OptionSide) {
  const TREE = side === "call" ? CALL_TREE : PUT_TREE;
  describe(`the ${side} (${side === "call" ? "Call" : "Put"}.es)`, () => {
    const chain = new MockChain({ height: 1_900_000 });
    const writer = chain.newParty("writer");
    const buyer = chain.newParty("buyer");
    const stranger = chain.newParty("stranger");
    const options = chain.addParty(TREE, "options");
    afterEach(() => chain.reset({ clearParties: true }));

    const terms = () => ({
      side,
      writer: writer.address,
      tokenId: TOKEN,
      amount: AMOUNT,
      strike: STRIKE,
      expiry: chain.height + TERM,
      premium: PREMIUM,
    });

    /** Funds every party, writes one option, and returns its view; the call writer holds the tokens, the put buyer and stranger do. */
    function write() {
      writer.addBalance({ nanoergs: 10n * ERG, tokens: side === "call" ? [{ tokenId: TOKEN, amount: 100n }] : [] });
      buyer.addBalance({ nanoergs: 5n * ERG, tokens: side === "put" ? [{ tokenId: TOKEN, amount: 100n }] : [] });
      stranger.addBalance({ nanoergs: 5n * ERG, tokens: side === "put" ? [{ tokenId: TOKEN, amount: 100n }] : [] });
      for (const p of [writer, buyer, stranger, options]) chain.addParty(p);
      const t = terms();
      const sized = sizeWrite(t, chain.height);
      const tx = buildWrite({ ...t, height: chain.height, inputs: writer.utxos.toArray() });
      expect(chain.execute(tx, { signers: [writer] })).toBe(true);
      const v = describeOption(options.utxos.at(0));
      expect(v.side).toBe(side);
      expect(v.sold).toBe(false);
      expect(v.buyer).toBeUndefined();
      expect(v.writer).toBe(writer.address.encode());
      expect(v.tokenId).toBe(TOKEN);
      expect(v.amount).toBe(AMOUNT);
      expect(v.strike).toBe(STRIKE);
      expect(v.strikeTotal).toBe(STRIKE * AMOUNT);
      expect(v.expiry).toBe(t.expiry);
      expect(v.premium).toBe(PREMIUM);
      expect(v.value).toBe(sized.value);
      return { v, sized, expiry: t.expiry };
    }

    const box = () => options.utxos.at(0);
    const buy = (who = buyer, height = chain.height) =>
      buildBuy({ height, inputs: who.utxos.toArray(), buyer: who.address, optionBox: box() });
    const exercise = (who = buyer, height = chain.height) =>
      buildExercise({ height, inputs: who.utxos.toArray(), buyer: who.address, optionBox: box() });
    const reclaim = (height = chain.height) =>
      buildReclaim({ height, inputs: writer.utxos.toArray(), writer: writer.address, optionBox: box() });
    /** A sold option: written, then bought by the buyer. */
    function sold() {
      const w = write();
      expect(chain.execute(buy(), { signers: [buyer] })).toBe(true);
      return w;
    }
    /** Builds an exercise past the builder's own guard by lying to it about the height, then sets the real one. */
    function forcedExercise(who: typeof buyer) {
      const tx = buildExercise({
        height: chain.height - TERM,
        inputs: who.utxos.toArray(),
        buyer: who.address,
        optionBox: box(),
      });
      return tx;
    }

    it("1. write: the box holds the underlying and the terms, R7 absent; the builder refuses an expiry past a rent period", () => {
      const { v, sized } = write();
      const b = box();
      expect(b.additionalRegisters.R7).toBeUndefined();
      if (side === "call") {
        expect(b.assets).toEqual([{ tokenId: TOKEN, amount: AMOUNT }]);
        expect(sized.rentReserve).toBe(BigInt(sized.bytes) * STORAGE_FEE_FACTOR);
        expect(v.value).toBe(sized.rentReserve);
        expect(writer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 100n - AMOUNT }]);
      } else {
        expect(b.assets).toEqual([]);
        expect(sized.rentReserve).toBe(0n);
        expect(v.value).toBe(STRIKE * AMOUNT); // the collateral, nothing more
      }
      console.log(
        `${side} box: ${sized.bytes} bytes (sized as sold), value ${sized.value} nanoERG (rent reserve ${sized.rentReserve}); tree ${new ErgoTree(TREE).bytes.length} bytes`,
      );
      const t = terms();
      expect(() => sizeWrite({ ...t, expiry: chain.height + RENT_PERIOD + 1 }, chain.height)).toThrow(/rent period/);
      expect(() => sizeWrite({ ...t, expiry: chain.height + RENT_PERIOD }, chain.height)).not.toThrow();
      expect(() => sizeWrite({ ...t, expiry: chain.height }, chain.height)).toThrow(/after now/);
      expect(() => sizeWrite({ ...t, premium: OWNER_BOX_VALUE - 1n }, chain.height)).toThrow(/premium/);
      expect(() => sizeWrite({ ...t, amount: 0n }, chain.height)).toThrow(/amount/);
      if (side === "put") expect(() => sizeWrite({ ...t, strike: 1n, amount: 1n }, chain.height)).toThrow(/minimum/);
      expect(canBuy(v, chain.height)).toBe(true);
      expect(canExercise(v, chain.height)).toBe(false);
      expect(canReclaim(v, chain.height)).toBe(true);
    });

    it("2. buy by a stranger is accepted: the premium to the writer, the stranger in R7, the box's value and tokens unchanged", () => {
      const { v } = write();
      const before = writer.balance.nanoergs;
      const tx = buy(stranger);
      expect(tx.outputs[0].ergoTree).toBe(writer.address.ergoTree);
      expect(tx.outputs[0].additionalRegisters.R4).toBe(SColl(SByte, v.boxId).toHex());
      expect(tx.outputs[1].ergoTree).toBe(TREE);
      expect(tx.inputs[optionIndex(tx, TREE)].extension).toEqual({ 0: "0400", 1: "0402" });
      expect(chain.execute(tx, { signers: [stranger] })).toBe(true);
      expect(writer.balance.nanoergs - before).toBe(PREMIUM);
      expect(stranger.balance.nanoergs).toBe(5n * ERG - PREMIUM - FEE);
      const after = describeOption(box());
      expect(after.sold).toBe(true);
      expect(after.buyer).toBe(stranger.address.encode());
      expect(after.value).toBe(v.value);
      expect(box().assets).toEqual(side === "call" ? [{ tokenId: TOKEN, amount: AMOUNT }] : []);
      expect(after.writer).toBe(v.writer);
      expect(after.strikeTotal).toBe(v.strikeTotal);
      expect(after.expiry).toBe(v.expiry);
      expect(canBuy(after, chain.height)).toBe(false);
      expect(canExercise(after, chain.height, stranger.address.encode())).toBe(true);
      expect(canExercise(after, chain.height, buyer.address.encode())).toBe(false);
      expect(canReclaim(after, chain.height)).toBe(false);
    });

    it("3. a second buy of a sold box is refused", () => {
      sold();
      expect(() => buy(stranger)).toThrow(/already sold/);
      // forced past the builder: the same transaction shape against the sold box, the premium paid again, the
      // stranger written over the buyer
      const b = box();
      const r = b.additionalRegisters;
      const pay = new OutputBuilder(PREMIUM, writer.address).setAdditionalRegisters({
        R4: SColl(SByte, b.boxId).toHex(),
      });
      const next = new OutputBuilder(b.value, TREE).setAdditionalRegisters({
        R4: r.R4 as string,
        R5: r.R5 as string,
        R6: r.R6 as string,
        R7: SSigmaProp(SGroupElement(stranger.key.publicKey)).toHex(),
      });
      if (b.assets.length) next.addTokens(b.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount })));
      const tx = new TransactionBuilder(chain.height)
        .from([new ErgoUnsignedInput(b).setContextExtension({ 0: SInt(0), 1: SInt(1) }), ...stranger.utxos.toArray()])
        .configureSelector((sel) => sel.ensureInclusion([b.boxId]))
        .to([pay, next])
        .sendChangeTo(stranger.address)
        .payFee(FEE)
        .build()
        .toEIP12Object();
      expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
      expect(describeOption(box()).buyer).toBe(buyer.address.encode());
    });

    it("4. exercise by the buyer before the expiry is accepted: the strike to the writer, the underlying across", () => {
      const { v } = sold();
      chain.jumpTo(chain.height + TERM - 5);
      const writerErg = writer.balance.nanoergs,
        buyerErg = buyer.balance.nanoergs;
      const cur = describeOption(box()); // the sold box: a new id since the buy
      expect(cur.boxId).not.toBe(v.boxId);
      const tx = exercise();
      expect(tx.outputs[0].ergoTree).toBe(writer.address.ergoTree);
      expect(tx.outputs[1].ergoTree).toBe(buyer.address.ergoTree);
      expect(tx.outputs[0].additionalRegisters.R4).toBe(SColl(SByte, cur.boxId).toHex());
      expect(tx.outputs[1].additionalRegisters.R4).toBe(SColl(SByte, cur.boxId).toHex());
      expect(chain.execute(tx, { signers: [buyer] })).toBe(true);
      expect(options.utxos.length).toBe(0);
      if (side === "call") {
        expect(writer.balance.nanoergs - writerErg).toBe(v.value + v.strikeTotal); // the reserve back plus the strike
        expect(buyerErg - buyer.balance.nanoergs).toBe(v.strikeTotal + FEE); // the token box is the buyer's own ERG
        expect(buyer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: AMOUNT }]);
        expect(writer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 100n - AMOUNT }]);
      } else {
        expect(buyer.balance.nanoergs - buyerErg).toBe(v.value - OWNER_BOX_VALUE - FEE); // the collateral less the token box and the fee
        expect(writer.balance.nanoergs - writerErg).toBe(OWNER_BOX_VALUE);
        expect(writer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: AMOUNT }]);
        expect(buyer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 100n - AMOUNT }]);
      }
    });

    it("4b. exercise at the expiry itself is accepted (the last valid block)", () => {
      const { expiry } = sold();
      chain.jumpTo(expiry - 1); // HEIGHT = expiry
      expect(() => exercise()).not.toThrow();
      expect(chain.execute(exercise(), { signers: [buyer] })).toBe(true);
    });

    it("5. exercise at expiry + 1 is refused", () => {
      const { expiry } = sold();
      chain.jumpTo(expiry); // HEIGHT = expiry + 1
      expect(() => exercise()).toThrow(/expired/);
      expect(chain.execute(forcedExercise(buyer), { signers: [buyer], throw: false })).toBe(false);
      expect(options.utxos.length).toBe(1);
    });

    it("6. exercise by a non-buyer is refused", () => {
      sold();
      expect(() => exercise(stranger)).toThrow(/named buyer/);
      // forced past the builder: the stranger pays and takes the underlying, signing with their own key
      const b = box();
      const tx = buildExercise({
        height: chain.height,
        inputs: stranger.utxos.toArray(),
        buyer: buyer.address,
        optionBox: b,
      });
      tx.outputs[1].ergoTree = stranger.address.ergoTree;
      expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
      // and with the buyer's outputs but the stranger's signature
      const tx2 = buildExercise({
        height: chain.height,
        inputs: stranger.utxos.toArray(),
        buyer: buyer.address,
        optionBox: b,
      });
      expect(chain.execute(tx2, { signers: [stranger], throw: false })).toBe(false);
      expect(options.utxos.length).toBe(1);
    });

    it(`7. exercise ${side === "call" ? "paying one nanoERG less than the strike" : "delivering one unit less than the amount"} is refused`, () => {
      sold();
      const tx = exercise();
      if (side === "call") {
        tx.outputs[0].value = (BigInt(tx.outputs[0].value) - 1n).toString();
        tx.outputs[2].value = (BigInt(tx.outputs[2].value) + 1n).toString(); // the change keeps the balance
      } else {
        tx.outputs[0].assets[0].amount = (AMOUNT - 1n).toString();
        tx.outputs[2].assets = [
          { tokenId: TOKEN, amount: (BigInt(tx.outputs[2].assets[0]?.amount ?? "0") + 1n).toString() },
        ];
      }
      expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
      expect(options.utxos.length).toBe(1);
    });

    it("8. writer reclaim at the expiry is refused and at expiry + 1 accepted", () => {
      const { v, expiry } = sold();
      chain.jumpTo(expiry - 1); // HEIGHT = expiry: still the buyer's
      expect(canReclaim(describeOption(box()), chain.height)).toBe(false);
      expect(() => reclaim()).toThrow(/open until/);
      const forced = reclaim(expiry);
      expect(chain.execute(forced, { signers: [writer], throw: false })).toBe(false);
      chain.jumpTo(expiry); // HEIGHT = expiry + 1
      expect(canReclaim(describeOption(box()), chain.height)).toBe(true);
      const writerErg = writer.balance.nanoergs;
      const tx = reclaim();
      expect(tx.outputs[0].additionalRegisters.R4).toBe(SColl(SByte, describeOption(box()).boxId).toHex());
      expect(chain.execute(tx, { signers: [writer] })).toBe(true);
      expect(options.utxos.length).toBe(0);
      expect(writer.balance.nanoergs - writerErg).toBe(v.value - FEE);
      if (side === "call") expect(writer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 100n }]);
    });

    it("9. writer cancel while unsold is accepted", () => {
      const { v } = write();
      const writerErg = writer.balance.nanoergs;
      const tx = buildCancelUnsold({
        height: chain.height,
        inputs: writer.utxos.toArray(),
        writer: writer.address,
        optionBox: box(),
      });
      expect(chain.execute(tx, { signers: [writer] })).toBe(true);
      expect(options.utxos.length).toBe(0);
      expect(writer.balance.nanoergs - writerErg).toBe(v.value - FEE);
      if (side === "call") expect(writer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: 100n }]);
    });

    it("9b. a stranger cannot cancel an unsold option", () => {
      write();
      expect(() =>
        buildCancelUnsold({
          height: chain.height,
          inputs: stranger.utxos.toArray(),
          writer: stranger.address,
          optionBox: box(),
        }),
      ).toThrow(/only the writer/);
      const tx = buildCancelUnsold({
        height: chain.height,
        inputs: stranger.utxos.toArray(),
        writer: writer.address,
        optionBox: box(),
      });
      tx.outputs[0].ergoTree = stranger.address.ergoTree;
      expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
    });

    it("10. writer cancel after the sale, before the expiry, is refused", () => {
      sold();
      expect(() =>
        buildCancelUnsold({
          height: chain.height,
          inputs: writer.utxos.toArray(),
          writer: writer.address,
          optionBox: box(),
        }),
      ).toThrow(/sold/);
      expect(() => reclaim()).toThrow(/open until/);
      const forced = reclaim(chain.height + TERM);
      expect(chain.execute(forced, { signers: [writer], throw: false })).toBe(false);
      expect(options.utxos.length).toBe(1);
    });

    it("11. premium one nanoERG short is refused", () => {
      write();
      const tx = buy(stranger);
      tx.outputs[0].value = (PREMIUM - 1n).toString();
      tx.outputs[2].value = (BigInt(tx.outputs[2].value) + 1n).toString();
      expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
      expect(describeOption(box()).sold).toBe(false);
    });

    it("12. two option boxes in one transaction are refused", () => {
      write();
      // a second, identical offer from the same writer
      const tx2 = buildWrite({ ...terms(), height: chain.height, inputs: writer.utxos.toArray() });
      expect(chain.execute(tx2, { signers: [writer] })).toBe(true);
      expect(options.utxos.length).toBe(2);
      const [a, b] = options.utxos.toArray();
      // one buy claiming both: the second box joins the inputs; its premium and successor are the same outputs, its
      // underlying goes to the buyer's change
      const tx = buildBuy({
        height: chain.height,
        inputs: stranger.utxos.toArray(),
        buyer: stranger.address,
        optionBox: a,
      });
      const k = optionIndex(tx, TREE);
      tx.inputs.push({
        ...b,
        value: b.value.toString(),
        assets: b.assets.map((t) => ({ ...t, amount: t.amount.toString() })),
        extension: tx.inputs[k].extension,
      });
      const change = tx.outputs[2];
      change.value = (BigInt(change.value) + b.value).toString();
      if (b.assets.length) change.assets = [...change.assets, { tokenId: TOKEN, amount: AMOUNT.toString() }];
      expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
      expect(options.utxos.length).toBe(2);
      // and two sold boxes exercised in one transaction, each with its own outputs, are refused too
      expect(
        chain.execute(
          buildBuy({ height: chain.height, inputs: buyer.utxos.toArray(), buyer: buyer.address, optionBox: a }),
          { signers: [buyer] },
        ),
      ).toBe(true);
      expect(
        chain.execute(
          buildBuy({
            height: chain.height,
            inputs: buyer.utxos.toArray(),
            buyer: buyer.address,
            optionBox: options.utxos.toArray().find((x) => x.boxId === b.boxId)!,
          }),
          { signers: [buyer] },
        ),
      ).toBe(true);
      const [s1, s2] = options.utxos.toArray();
      const e1 = buildExercise({
        height: chain.height,
        inputs: buyer.utxos.toArray(),
        buyer: buyer.address,
        optionBox: s1,
      });
      const e2 = buildExercise({
        height: chain.height,
        inputs: buyer.utxos.toArray(),
        buyer: buyer.address,
        optionBox: s2,
      });
      // merge: e1's inputs plus s2 with vars pointing at e2's two outputs appended after e1's; the change absorbs the rest
      const k2 = optionIndex(e2, TREE);
      const merged = {
        ...e1,
        inputs: [...e1.inputs, { ...e2.inputs[k2], extension: { 0: "0406", 1: "0408" } }],
        outputs: [...e1.outputs, e2.outputs[0], e2.outputs[1]],
      };
      // balance: the buyer's change must now also fund e2's two outputs; take from e1's change instead of adding inputs
      const need = BigInt(e2.outputs[0].value) + BigInt(e2.outputs[1].value) - s2.value;
      merged.outputs[2] = { ...merged.outputs[2], value: (BigInt(merged.outputs[2].value) - need).toString() };
      if (side === "put") {
        merged.outputs[2] = {
          ...merged.outputs[2],
          assets: merged.outputs[2].assets.map((t) => ({ ...t, amount: (BigInt(t.amount) - AMOUNT).toString() })),
        };
      }
      expect(chain.execute(merged, { signers: [buyer], throw: false })).toBe(false);
      expect(options.utxos.length).toBe(2);
    });

    it("13. (added) a buy at the expiry is accepted; at expiry + 1 the builder refuses and, forced, so does the script", () => {
      const { expiry } = write();
      chain.jumpTo(expiry - 1); // HEIGHT = expiry: the last block a buy lands in
      expect(canBuy(describeOption(box()), chain.height)).toBe(true);
      expect(chain.execute(buy(), { signers: [buyer] })).toBe(true);
      expect(describeOption(box()).sold).toBe(true);
      chain.reset({ clearParties: true });
      const w = write();
      chain.jumpTo(w.expiry); // HEIGHT = expiry + 1
      expect(canBuy(describeOption(box()), chain.height)).toBe(false);
      expect(() => buy()).toThrow(/expired/);
      const late = buy(buyer, chain.height - TERM);
      expect(chain.execute(late, { signers: [buyer], throw: false })).toBe(false);
      expect(describeOption(box()).sold).toBe(false);
    });

    it("14. (added) prints the evaluation cost of the buy and the exercise", () => {
      write();
      const b = buy();
      const buyCost = scriptCost(chain, b, optionIndex(b, TREE));
      expect(chain.execute(b, { signers: [buyer] })).toBe(true);
      const e = exercise();
      const exerciseCost = scriptCost(chain, e, optionIndex(e, TREE));
      expect(chain.execute(e, { signers: [buyer] })).toBe(true);
      console.log(
        `cost of a ${side}: buy ${buyCost}, exercise ${exerciseCost}; tree ${new ErgoTree(TREE).bytes.length} bytes`,
      );
      expect(buyCost).toBeGreaterThan(0);
      expect(exerciseCost).toBeGreaterThan(0);
      expect(exerciseCost).toBeLessThan(100_000);
    });
  });
}

suite("call");
suite("put");
