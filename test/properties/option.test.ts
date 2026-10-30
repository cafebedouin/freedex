// An option's exercise and reclaim are accepted and refused on each side of the expiry, over random terms on both
// sides. The mock chain evaluates at HEIGHT = chain.height + 1 and the script's `open` is HEIGHT <= expiry, so
// chain.height = expiry - 1 is the last block an exercise lands in and chain.height = expiry the first a reclaim
// does. The builders' guards (canExercise: height < expiry; canReclaim: height >= expiry) coincide with the script
// at those heights, so the refused side of each edge is forced past the guard by lying to the builder about the
// height, as src/protocols/option/option.test.ts does.
import { MockChain } from "@fleet-sdk/mock-chain";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { OWNER_BOX_VALUE } from "../../src/protocols/clock/clock";
import {
  CALL_TREE,
  PUT_TREE,
  buildBuy,
  buildExercise,
  buildReclaim,
  buildWrite,
  canExercise,
  canReclaim,
  describeOption,
  type OptionSide,
} from "../../src/protocols/option/option";
import { FEE } from "../../src/protocols/machina/orders";
import { big, report } from "./setup";

const TOKEN = "44".repeat(32);
const ERG = 1_000_000_000n;

const termsCase = fc
  .record({
    amount: big(1n, 1_000_000n),
    strike: big(1n, 10n * ERG),
    premium: big(OWNER_BOX_VALUE, 1n * ERG),
    term: fc.integer({ min: 1, max: 2000 }),
  })
  // a put's collateral must be a box the node accepts; keep strike x amount to a million ERG so every party can be funded
  .filter((t) => t.strike * t.amount >= 1_000_000n && t.strike * t.amount <= 1_000_000n * ERG);

function suite(side: OptionSide) {
  describe(`the ${side}`, () => {
    const chain = new MockChain({ height: 1_900_000 });
    const writer = chain.newParty("writer");
    const buyer = chain.newParty("buyer");
    const options = chain.addParty(side === "call" ? CALL_TREE : PUT_TREE, "options");
    const box = () => options.utxos.at(0);
    const exercise = (height: number) =>
      buildExercise({ height, inputs: buyer.utxos.toArray(), buyer: buyer.address, optionBox: box() });
    const reclaim = (height: number) =>
      buildReclaim({ height, inputs: writer.utxos.toArray(), writer: writer.address, optionBox: box() });

    it("exercise at the expiry is accepted and at expiry + 1 refused; reclaim is refused at the expiry and accepted at expiry + 1", () => {
      const N = 12;
      fc.assert(
        fc.property(termsCase, fc.boolean(), (t, exerciseSide) => {
          chain.reset({ clearParties: true });
          const total = t.strike * t.amount;
          writer.addBalance({
            nanoergs: total + 10n * ERG,
            tokens: side === "call" ? [{ tokenId: TOKEN, amount: t.amount }] : [],
          });
          buyer.addBalance({
            nanoergs: total + 10n * ERG,
            tokens: side === "put" ? [{ tokenId: TOKEN, amount: t.amount }] : [],
          });
          for (const p of [writer, buyer, options]) chain.addParty(p);
          const expiry = chain.height + t.term;
          const terms = {
            side,
            writer: writer.address,
            tokenId: TOKEN,
            amount: t.amount,
            strike: t.strike,
            expiry,
            premium: t.premium,
          };
          expect(
            chain.execute(buildWrite({ ...terms, height: chain.height, inputs: writer.utxos.toArray() }), {
              signers: [writer],
            }),
          ).toBe(true);
          expect(
            chain.execute(
              buildBuy({ height: chain.height, inputs: buyer.utxos.toArray(), buyer: buyer.address, optionBox: box() }),
              { signers: [buyer] },
            ),
          ).toBe(true);
          const v = describeOption(box());
          expect(v.sold && v.buyer === buyer.address.encode()).toBe(true);

          if (exerciseSide) {
            // chain.height = expiry: HEIGHT = expiry + 1, the option is closed; the builder refuses, the script refuses a forced one
            chain.jumpTo(expiry);
            expect(canExercise(v, chain.height, buyer.address.encode())).toBe(false);
            expect(() => exercise(chain.height)).toThrow(/expired/);
            expect(chain.execute(exercise(expiry - 1), { signers: [buyer], throw: false })).toBe(false);
            expect(options.utxos.length).toBe(1);
            // chain.height = expiry - 1: HEIGHT = expiry, the last block an exercise lands in
            chain.jumpTo(expiry - 1);
            expect(canExercise(v, chain.height, buyer.address.encode())).toBe(true);
            const writerErg = writer.balance.nanoergs;
            expect(chain.execute(exercise(chain.height), { signers: [buyer] })).toBe(true);
            expect(options.utxos.length).toBe(0);
            if (side === "call") {
              expect(writer.balance.nanoergs - writerErg).toBe(v.value + total);
              expect(buyer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: t.amount }]);
            } else {
              expect(writer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: t.amount }]);
              expect(buyer.balance.nanoergs).toBe(
                total + 10n * ERG - t.premium - FEE + v.value - FEE - OWNER_BOX_VALUE,
              );
            }
          } else {
            // chain.height = expiry - 1: HEIGHT = expiry, still the buyer's; the writer's reclaim is refused
            chain.jumpTo(expiry - 1);
            expect(canReclaim(v, chain.height)).toBe(false);
            expect(() => reclaim(chain.height)).toThrow(/open until/);
            expect(chain.execute(reclaim(expiry), { signers: [writer], throw: false })).toBe(false);
            expect(options.utxos.length).toBe(1);
            // chain.height = expiry: HEIGHT = expiry + 1, the writer takes the box back
            chain.jumpTo(expiry);
            expect(canReclaim(v, chain.height)).toBe(true);
            const writerErg = writer.balance.nanoergs;
            expect(chain.execute(reclaim(chain.height), { signers: [writer] })).toBe(true);
            expect(options.utxos.length).toBe(0);
            expect(writer.balance.nanoergs - writerErg).toBe(v.value - FEE);
            if (side === "call") expect(writer.balance.tokens).toEqual([{ tokenId: TOKEN, amount: t.amount }]);
          }
        }),
        { numRuns: N },
      );
      report(`option: ${side} exercise and reclaim at the expiry`, N);
    });
  });
}

suite("call");
suite("put");
