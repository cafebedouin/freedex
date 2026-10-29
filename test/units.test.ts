import { describe, expect, it } from "vitest";
import { ergPerTokenToPrice, formatUnits, parseUnits, priceToErgPerToken } from "../src/units";

describe("units", () => {
  it("parses decimals exactly", () => {
    expect(parseUnits("1", 9)).toBe(1_000_000_000n);
    expect(parseUnits("0.000000001", 9)).toBe(1n);
    expect(parseUnits(".5", 2)).toBe(50n);
    expect(parseUnits("12.", 0)).toBe(12n);
    expect(parseUnits(" 3.25 ", 2)).toBe(325n);
  });
  it("refuses too many decimals, empty and non-numbers", () => {
    expect(() => parseUnits("1.234", 2)).toThrow(/decimals/);
    expect(() => parseUnits("", 2)).toThrow(/not a number/);
    expect(() => parseUnits("abc", 2)).toThrow(/not a number/);
    expect(() => parseUnits("1e3", 2)).toThrow(/not a number/);
    expect(() => parseUnits("-1", 2)).toThrow(/not a number/);
  });
  it("formats and round-trips", () => {
    expect(formatUnits(1_000_000_000n, 9)).toBe("1");
    expect(formatUnits(1_500_000_000n, 9)).toBe("1.5");
    expect(formatUnits(5n, 2)).toBe("0.05");
    expect(formatUnits(0n, 2)).toBe("0");
    expect(formatUnits(123456789n, 9, 3)).toBe("0.123");
    expect(formatUnits(-25n, 1)).toBe("-2.5");
    for (const [t, d] of [
      ["123.456", 3],
      ["0.01", 2],
      ["7", 0],
    ] as const)
      expect(formatUnits(parseUnits(t, d), d)).toBe(t);
  });
  it("prices: nanoERG per unit against ERG per whole token", () => {
    expect(priceToErgPerToken(36_186n, 2)).toBe("0.0036186"); // FAKU, 2 decimals
    expect(ergPerTokenToPrice("0.0036186", 2)).toBe(36_186n);
    expect(ergPerTokenToPrice("1", 0)).toBe(1_000_000_000n);
    expect(() => ergPerTokenToPrice("0.000000001", 2)).toThrow(/multiple/);
  });
});
