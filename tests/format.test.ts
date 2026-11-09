import { describe, expect, it } from "vitest";

import { moneyShort, shares } from "@/lib/format";

describe("moneyShort", () => {
  it("puts the sign before the $, not between it and the digits", () => {
    // Leveraged positions let cash go negative (margin debt) — these two
    // branches are the only ones that ever render a negative value.
    expect(moneyShort(-2_000_000)).toBe("-$2.00M");
    expect(moneyShort(-50_000)).toBe("-$50,000");
  });

  it("still reads normally for positive values", () => {
    expect(moneyShort(2_000_000)).toBe("$2.00M");
    expect(moneyShort(50_000)).toBe("$50,000");
  });
});

describe("shares", () => {
  it("never leaves a dangling decimal point", () => {
    // Floating-point drift can land a dollars-mode order at e.g. 9.999999
    // shares instead of a clean 10 — toFixed(4) then rounds that up to
    // "10.0000", and stripping trailing zeros alone used to leave "10.".
    expect(shares(9.99999999)).not.toMatch(/\.$/);
    expect(shares(9.99999999)).toBe("10");
  });

  it("keeps a meaningful fractional part when one exists", () => {
    expect(shares(123.45)).toBe("123.45");
    expect(shares(0.5)).toBe("0.5");
  });

  it("prints a whole number with no decimal point at all", () => {
    expect(shares(10)).toBe("10");
  });
});
