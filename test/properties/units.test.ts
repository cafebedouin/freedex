// Decimal text and smallest units: the round trip is the identity on canonical strings, and parseUnits refuses
// everything outside its grammar. Note what "non-canonical" means here: parseUnits accepts leading zeros, trailing
// zeros, a bare trailing dot and surrounding whitespace by design (test/units.test.ts "parses decimals exactly"),
// and formatUnits then prints the canonical form; what it refuses is anything with a sign, an exponent, a letter, a
// second dot, a thousands separator, no digit at all, or more fraction digits than the token has decimals.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ergPerTokenToPrice, formatUnits, parseUnits, priceToErgPerToken } from "../../src/units";
import { big, report, TWO_62 } from "./setup";

/** A string of `min` to `max` decimal digits (drawn as digits, not by regex, which is slow). */
const digits = (min: number, max: number) =>
  fc.array(fc.integer({ min: 0, max: 9 }), { minLength: min, maxLength: max }).map((a) => a.join(""));
const decimals = fc.integer({ min: 0, max: 9 });

/** A canonical decimal string for `d` decimals: no leading zero unless the integer part is 0, no trailing zero in the fraction. */
const canonical = decimals.chain((d) =>
  fc
    .record({
      int: fc.oneof(
        fc.constant("0"),
        digits(1, 18).map((s) => s.replace(/^0+/, "") || "0"),
      ),
      frac: d === 0 ? fc.constant("") : digits(1, d).map((s) => s.replace(/0+$/, "")),
    })
    .map(({ int, frac }) => ({ d, text: frac ? `${int}.${frac}` : int })),
);

describe("formatUnits(parseUnits(t, d), d) is the identity on canonical decimal strings", () => {
  it("for every d in 0 to 9", () => {
    const N = 2000;
    fc.assert(
      fc.property(canonical, ({ d, text }) => {
        const units = parseUnits(text, d);
        expect(formatUnits(units, d)).toBe(text);
        // and the integer is exact: the digits with the point removed, right-padded to d
        const [i, f = ""] = text.split(".");
        expect(units).toBe(BigInt(i + f.padEnd(d, "0")));
      }),
      { numRuns: N },
    );
    report("units: round trip", N);
  });
  it("accepted non-canonical forms (leading or trailing zeros, a bare dot, whitespace) parse to the same integer as their canonical form", () => {
    const N = 1500;
    const padded = canonical.chain(({ d, text }) =>
      fc
        .record({
          lead: digits(0, 3).map((s) => "0".repeat(s.length)),
          trail: fc.integer({ min: 0, max: Math.max(0, d - (text.split(".")[1] ?? "").length) }),
          ws: fc.constantFrom("", " ", "\t", "  "),
          dot: fc.boolean(),
        })
        .map(({ lead, trail, ws, dot }) => {
          let t = lead + text;
          if (t.includes(".")) t += "0".repeat(trail);
          else if (trail > 0 && d > 0) t += "." + "0".repeat(trail);
          else if (dot && d > 0) t += ".";
          return { d, text, variant: ws + t + ws };
        }),
    );
    fc.assert(
      fc.property(padded, ({ d, text, variant }) => {
        expect(parseUnits(variant, d)).toBe(parseUnits(text, d));
        expect(formatUnits(parseUnits(variant, d), d)).toBe(text);
      }),
      { numRuns: N },
    );
    report("units: non-canonical accepted forms normalise", N);
  });
});

describe("parseUnits refuses everything outside its grammar", () => {
  it("a sign, an exponent, a letter, a second dot, a comma, or no digit: 'not a number'", () => {
    const N = 2000;
    const bad = fc.oneof(
      fc.tuple(fc.constantFrom("-", "+"), digits(1, 5)).map(([s, n]) => s + n),
      fc.tuple(digits(1, 5), fc.constantFrom("e", "E"), digits(1, 2)).map(([a, e, b]) => a + e + b),
      fc
        .tuple(digits(0, 3), fc.constantFrom("a", "x", "_", "E", "abc", "nan"), digits(0, 3))
        .map(([a, l, b]) => a + l + b),
      fc.tuple(digits(1, 3), digits(0, 3), digits(1, 3)).map(([a, b, c]) => `${a}.${b}.${c}`),
      fc.tuple(digits(1, 3), digits(3, 3)).map(([a, b]) => `${a},${b}`),
      fc.constantFrom("", " ", ".", " . ", "\t"),
      fc.tuple(digits(1, 4), fc.constantFrom("$", "%", "/")).map(([a, s]) => a + s),
    );
    fc.assert(
      fc.property(bad, decimals, (text, d) => {
        expect(() => parseUnits(text, d)).toThrow(/not a number/);
      }),
      { numRuns: N },
    );
    report("units: refused strings", N);
  });
  it("more fraction digits than the token has decimals: 'more than d decimals'", () => {
    const N = 1000;
    const tooLong = decimals.chain((d) =>
      fc.tuple(digits(0, 6), digits(d + 1, d + 4)).map(([i, f]) => ({ d, text: `${i}.${f}` })),
    );
    fc.assert(
      fc.property(tooLong, ({ d, text }) => {
        expect(() => parseUnits(text, d)).toThrow(new RegExp(`more than ${d} decimals`));
      }),
      { numRuns: N },
    );
    report("units: too many decimals refused", N);
  });
});

describe("prices: nanoERG per smallest unit against ERG per whole token", () => {
  it("ergPerTokenToPrice(priceToErgPerToken(p, d), d) is p for every d in 0 to 9 and p up to 2^62", () => {
    const N = 2000;
    fc.assert(
      fc.property(big(1n, TWO_62), decimals, (p, d) => {
        expect(ergPerTokenToPrice(priceToErgPerToken(p, d), d)).toBe(p);
      }),
      { numRuns: N },
    );
    report("units: price round trip", N);
  });
});
