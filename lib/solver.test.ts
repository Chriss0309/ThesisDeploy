import { describe, expect, it } from "vitest";

import {
  allocationFromUnits,
  executionPrice,
  solveWholeShares,
  type SolverLine,
} from "@/lib/solver";

const units = (lines: { units: number }[]) => lines.map((line) => line.units);

describe("executionPrice", () => {
  const quote = { last: 100, bid: 99.5, ask: 100.5 };

  it("buys at the ask and sells at the bid while the market is open", () => {
    expect(executionPrice(quote, "buy")).toBe(100.5);
    expect(executionPrice(quote, "sell")).toBe(99.5);
  });

  it("falls back to the last trade when the side quote is missing or zero", () => {
    expect(executionPrice({ last: 100, ask: 0 }, "buy")).toBe(100);
    expect(executionPrice({ last: 100, bid: null }, "sell")).toBe(100);
  });

  it("prefers the last trade when the market is closed", () => {
    expect(executionPrice(quote, "buy", { marketOpen: false })).toBe(100);
    expect(executionPrice({ ask: 101 }, "buy", { marketOpen: false })).toBe(101);
  });

  it("returns null without a positive price", () => {
    expect(executionPrice({ last: 0, bid: -1 }, "sell")).toBeNull();
    expect(executionPrice({}, "buy")).toBeNull();
  });
});

describe("solveWholeShares", () => {
  it("applies the 1.5% slippage buffer before sizing", () => {
    const lines = [{ symbol: "VST", weight: 1, price: 100 }];
    const buffered = solveWholeShares({ budget: 1000, lines });
    expect(buffered.spendCap).toBeCloseTo(985);
    expect(units(buffered.lines)).toEqual([9]);
    expect(buffered.unallocated).toBeCloseTo(100);

    expect(units(solveWholeShares({ budget: 1000, lines, slippageBuffer: 0 }).lines)).toEqual([10]);
  });

  it("floors each slice, then adds a share where it cuts the dollar error and fits the cash", () => {
    // B_eff = 985, slice = 246.25 each.
    const result = solveWholeShares({
      budget: 1000,
      lines: [
        { symbol: "CEG", weight: 25, price: 180 }, // 1 share; shortfall 66.25 < 90, rounding up overshoots more
        { symbol: "ETN", weight: 25, price: 45 }, // 5 shares; shortfall 21.25 < 22.5
        { symbol: "CCJ", weight: 25, price: 61 }, // 4 shares
        { symbol: "VST", weight: 25, price: 97.5 }, // 2 shares; shortfall 51.25 > 48.75, so +1
      ],
    });
    expect(units(result.lines)).toEqual([1, 5, 4, 3]);
    expect(result.invested).toBeCloseTo(941.5);
    expect(result.unallocated).toBeCloseTo(58.5);
    expect(result.invested).toBeLessThanOrEqual(result.spendCap);
  });

  it("reports achieved weights and tracking error against normalized targets", () => {
    const result = solveWholeShares({
      budget: 1000,
      slippageBuffer: 0,
      lines: [
        { symbol: "A", weight: 3, price: 100 },
        { symbol: "B", weight: 1, price: 100 },
      ],
    });
    expect(result.lines.map((l) => l.targetWeight)).toEqual([0.75, 0.25]);
    // 750 / 100 = 7.5 shares: an exact half share doesn't reduce L1 error, so no round-up.
    expect(units(result.lines)).toEqual([7, 2]);
    expect(result.lines[0].achievedWeight).toBeCloseTo(7 / 9);
    expect(result.trackingError).toBeCloseTo(7 / 9 - 0.75);
  });

  it("gives the remainder to the largest error reduction first", () => {
    // A: 0 shares, shortfall 500, gain 400. B: 0 shares, shortfall 250, gain 200.
    // 750 left after C: only one of A or B fits.
    const result = solveWholeShares({
      budget: 1000,
      slippageBuffer: 0,
      lines: [
        { symbol: "B", weight: 25, price: 300 },
        { symbol: "A", weight: 50, price: 600 },
        { symbol: "C", weight: 25, price: 1 },
      ],
    });
    expect(units(result.lines)).toEqual([0, 1, 250]);
    expect(result.lines[0].belowOneShare).toBe(true);
    expect(result.lines[1].belowOneShare).toBe(false);
  });

  it("breaks remainder ties by line order", () => {
    const lines: SolverLine[] = [
      { symbol: "X", weight: 1, price: 60 },
      { symbol: "Y", weight: 1, price: 60 },
    ];
    // Slices of 50; only one 60 share fits in 100.
    expect(units(solveWholeShares({ budget: 100, slippageBuffer: 0, lines }).lines)).toEqual([1, 0]);
    expect(
      units(solveWholeShares({ budget: 100, slippageBuffer: 0, lines: [...lines].reverse() }).lines),
    ).toEqual([1, 0]);
  });

  it("leaves an unaffordable name at zero shares without redistributing its slice", () => {
    const result = solveWholeShares({
      budget: 1000,
      lines: [
        { symbol: "BIG", weight: 25, price: 600 },
        { symbol: "A", weight: 25, price: 50 },
        { symbol: "B", weight: 25, price: 50 },
        { symbol: "C", weight: 25, price: 50 },
      ],
    });
    expect(units(result.lines)).toEqual([0, 5, 5, 5]);
    expect(result.lines[0].belowOneShare).toBe(true);
    expect(result.invested).toBe(750);
    expect(result.unallocated).toBe(250);
  });

  it("buys nothing with a zero budget", () => {
    const result = solveWholeShares({ budget: 0, lines: [{ symbol: "A", weight: 1, price: 10 }] });
    expect(units(result.lines)).toEqual([0]);
    expect(result.invested).toBe(0);
    expect(result.trackingError).toBe(1);
  });

  it("buys nothing when every weight is zero", () => {
    const result = solveWholeShares({
      budget: 1000,
      lines: [
        { symbol: "A", weight: 0, price: 10 },
        { symbol: "B", weight: 0, price: 10 },
      ],
    });
    expect(units(result.lines)).toEqual([0, 0]);
    expect(result.lines.every((l) => !l.belowOneShare)).toBe(true);
    expect(result.trackingError).toBe(0);
  });

  it("caps spending at available cash in Live mode", () => {
    const result = solveWholeShares({
      budget: 2500,
      cash: 1000,
      lines: [{ symbol: "A", weight: 1, price: 10 }],
    });
    expect(result.limitedByCash).toBe(true);
    expect(result.spendCap).toBeCloseTo(985);
    expect(units(result.lines)).toEqual([98]);
  });

  it("never exceeds the spend cap and leaves no improving share that fits", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    for (let run = 0; run < 500; run++) {
      const count = 1 + Math.floor(random() * 8);
      const lines = Array.from({ length: count }, (_, i) => ({
        symbol: `S${i}`,
        weight: random(),
        price: Math.round((1 + random() * 900) * 100) / 100,
      }));
      const budget = Math.round(random() * 20000 * 100) / 100;
      const result = solveWholeShares({ budget, lines });

      expect(result.invested).toBeLessThanOrEqual(result.spendCap + 1e-6);
      const remaining = result.spendCap - result.invested;
      for (const line of result.lines) {
        expect(Number.isInteger(line.units)).toBe(true);
        const shortfall = line.targetWeight * result.spendCap - line.cost;
        const gain = Math.abs(shortfall) - Math.abs(shortfall - line.price);
        expect(line.price <= remaining + 1e-6 && gain > 1e-6).toBe(false);
      }
    }
  });

  it("rejects invalid input", () => {
    const line = { symbol: "A", weight: 1, price: 10 };
    expect(() => solveWholeShares({ budget: -1, lines: [line] })).toThrow(RangeError);
    expect(() => solveWholeShares({ budget: Number.NaN, lines: [line] })).toThrow(RangeError);
    expect(() => solveWholeShares({ budget: 100, lines: [{ ...line, price: 0 }] })).toThrow(RangeError);
    expect(() => solveWholeShares({ budget: 100, lines: [{ ...line, weight: -1 }] })).toThrow(RangeError);
    expect(() => solveWholeShares({ budget: 100, lines: [line, line] })).toThrow(/duplicate/);
    expect(() => solveWholeShares({ budget: 100, lines: [line], slippageBuffer: 1 })).toThrow(RangeError);
  });
});

describe("allocationFromUnits", () => {
  const input = {
    budget: 1000,
    lines: [
      { symbol: "A", weight: 1, price: 100 },
      { symbol: "B", weight: 1, price: 50 },
    ],
  };

  it("re-prices stepper overrides against the same spend cap", () => {
    const within = allocationFromUnits(input, [5, 9]);
    expect(within.invested).toBe(950);
    expect(within.overSpendCap).toBe(false);

    const over = allocationFromUnits(input, [5, 10]);
    expect(over.invested).toBe(1000);
    expect(over.overSpendCap).toBe(true);
  });

  it("rejects fractional, negative, or misaligned units", () => {
    expect(() => allocationFromUnits(input, [1.5, 0])).toThrow(RangeError);
    expect(() => allocationFromUnits(input, [-1, 0])).toThrow(RangeError);
    expect(() => allocationFromUnits(input, [1])).toThrow(RangeError);
  });
});
