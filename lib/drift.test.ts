import { describe, expect, it } from "vitest";

import { computeDrift, planClose, planRebalance, type BasketPosition } from "@/lib/drift";

const position = (
  symbol: string,
  targetWeight: number,
  ledgerUnits: number,
  price: number,
  extra: Partial<BasketPosition> = {},
): BasketPosition => ({ symbol, targetWeight, ledgerUnits, price, ...extra });

describe("computeDrift", () => {
  it("measures drift in absolute weight against normalized targets", () => {
    const report = computeDrift([position("A", 1, 14, 4), position("B", 1, 11, 4)]);
    expect(report.totalValue).toBe(100);
    expect(report.lines[0]).toMatchObject({ targetWeight: 0.5, value: 56, currentWeight: 0.56 });
    expect(report.lines[0].drift).toBeCloseTo(0.06);
    expect(report.lines[1].drift).toBeCloseTo(-0.06);
    expect(report.maxAbsDrift).toBeCloseTo(0.06);
    expect(report.rebalanceRecommended).toBe(true);
  });

  it("does not flag drift of exactly 5 points", () => {
    // 0.55 - 0.5 is 0.05000000000000004 in floating point.
    const positions = [position("A", 0.5, 11, 5), position("B", 0.5, 9, 5)];
    expect(computeDrift(positions).rebalanceRecommended).toBe(false);
    expect(computeDrift(positions, { threshold: 0.04 }).rebalanceRecommended).toBe(true);
  });

  it("values the basket from min(ledger, actual) and flags the shortfall", () => {
    const report = computeDrift([
      position("A", 0.5, 10, 10, { actualUnits: 6 }),
      position("B", 0.5, 10, 10, { actualUnits: 25 }),
    ]);
    expect(report.lines.map((l) => l.units)).toEqual([6, 10]);
    expect(report.lines.map((l) => l.ledgerExceedsHoldings)).toEqual([true, false]);
    expect(report.totalValue).toBe(160);
  });

  it("reports an empty basket as zero drift with no recommendation", () => {
    const report = computeDrift([position("A", 0.5, 0, 10), position("B", 0.5, 3, 10, { actualUnits: 0 })]);
    expect(report.totalValue).toBe(0);
    expect(report.maxAbsDrift).toBe(0);
    expect(report.rebalanceRecommended).toBe(false);
  });

  it("rejects invalid positions", () => {
    expect(() => computeDrift([position("A", 1, 1, 0)])).toThrow(RangeError);
    expect(() => computeDrift([position("A", 1, -1, 10)])).toThrow(RangeError);
    expect(() => computeDrift([position("A", 1, 1, 10), position("A", 1, 1, 10)])).toThrow(/duplicate/);
  });
});

describe("planRebalance", () => {
  it("sells the overweight name and funds the underweight one, cash-neutral", () => {
    // V = 1,000, targets $500. Sell floor(100 / 60) = 1 A; $60 × 0.985 buys 1 B.
    const plan = planRebalance([position("A", 0.5, 10, 60), position("B", 0.5, 10, 40)]);
    expect(plan.legs).toEqual([
      { action: "SELL", symbol: "A", units: 1, estPrice: 60, estValue: 60 },
      { action: "BUY", symbol: "B", units: 1, estPrice: 40, estValue: 40 },
    ]);
    expect(plan.sellProceeds).toBe(60);
    expect(plan.buyCost).toBe(40);
  });

  it("sells at the bid and buys at the ask, or the mark when the market is closed", () => {
    const positions = [
      position("A", 0.5, 10, 60, { bid: 59.5, ask: 60.5 }),
      position("B", 0.5, 10, 40, { bid: 39.9, ask: 40.1 }),
    ];
    expect(planRebalance(positions).legs.map((l) => l.estPrice)).toEqual([59.5, 40.1]);
    expect(planRebalance(positions, { marketOpen: false }).legs.map((l) => l.estPrice)).toEqual([60, 40]);
  });

  it("orders every SELL before any BUY and weights buys by each gap", () => {
    // V = 1,800, targets $600. Sell 8 A for $400; gaps B $100, C $300.
    const plan = planRebalance([
      position("B", 1, 10, 50),
      position("A", 1, 20, 50),
      position("C", 1, 3, 100),
    ]);
    expect(plan.legs.map((l) => `${l.action} ${l.units} ${l.symbol}`)).toEqual([
      "SELL 8 A",
      "BUY 1 B",
      "BUY 3 C",
    ]);
    expect(plan.buyCost).toBeLessThanOrEqual(plan.sellProceeds * 0.985);
  });

  it("returns no legs when no whole share can move toward target", () => {
    const positions = [position("A", 0.5, 1, 600), position("B", 0.5, 1, 400)];
    expect(computeDrift(positions).rebalanceRecommended).toBe(true);
    expect(planRebalance(positions).legs).toEqual([]);
  });

  it("sizes sells from actual holdings when the ledger is higher", () => {
    // Ledger says 10 A (V = 800, sell 3); the account holds 8 (V = 680, sell 2).
    const plan = planRebalance([
      position("A", 0.5, 10, 60, { actualUnits: 8 }),
      position("B", 0.5, 5, 40, { actualUnits: 5 }),
    ]);
    expect(plan.legs[0]).toMatchObject({ action: "SELL", symbol: "A", units: 2 });
  });
});

describe("planClose", () => {
  it("sells floor(min(ledger, actual)) of each name and skips empty ones", () => {
    const legs = planClose([
      position("A", 0.4, 10, 60, { actualUnits: 8, bid: 59.9 }),
      position("B", 0.4, 5, 40, { actualUnits: 4.5 }),
      position("C", 0.2, 0, 10),
    ]);
    expect(legs).toEqual([
      { action: "SELL", symbol: "A", units: 8, estPrice: 59.9, estValue: 8 * 59.9 },
      { action: "SELL", symbol: "B", units: 4, estPrice: 40, estValue: 160 },
    ]);
  });
});
