import { describe, expect, it } from "vitest";

import { marketStatus } from "@/lib/market-hours";
import { ActionPlanError, buildActionPreflight } from "@/lib/theses/action-preflight";
import type { Marks } from "@/lib/theses/types";
import { markPrice, valueBasket, type HeldConstituent } from "@/lib/theses/valuation";

const OPEN = marketStatus("NYSE", new Date("2026-10-26T15:00:00Z"));
const CLOSED = marketStatus("NYSE", new Date("2026-10-24T15:00:00Z"));

const row = (symbol: string, ledgerUnits: number, costTotal: number, targetWeight = 0.5): HeldConstituent & { universalSymbolId: string } => ({
  symbol,
  companyName: `${symbol} Inc.`,
  targetWeight,
  ledgerUnits,
  costTotal,
  realizedTotal: 0,
  universalSymbolId: `id-${symbol}`,
});

const marks = (prices: Record<string, [number, number, number]>): Marks => ({
  source: "snaptrade",
  asOf: "2026-10-26T15:00:00Z",
  prices: Object.fromEntries(
    Object.entries(prices).map(([symbol, [last, bid, ask]]) => [symbol, { last, bid, ask }]),
  ),
});

const account = { id: "acct", name: "TFSA", institution: "Brokerage", isPaper: false };

describe("markPrice", () => {
  it("prefers the last trade, then the midpoint, then one side", () => {
    expect(markPrice({ last: 10, bid: 9, ask: 11 })).toBe(10);
    expect(markPrice({ last: null, bid: 9, ask: 11 })).toBe(10);
    expect(markPrice({ last: 0, bid: null, ask: 11 })).toBe(11);
    expect(markPrice({ last: null, bid: null, ask: null })).toBeNull();
    expect(markPrice(undefined)).toBeNull();
  });
});

describe("valueBasket", () => {
  const held = [row("AAA", 10, 1000), row("BBB", 10, 1000)];

  it("values holdings plus cash against what the deploy put in", () => {
    const valuation = valueBasket({
      constituents: held,
      marks: marks({ AAA: [120, 119, 121], BBB: [100, 99, 101] }),
      cash: 50,
      contributed: 2000,
    })!;
    expect(valuation.holdingsValue).toBe(2200);
    expect(valuation.unrealized).toBe(200);
    expect(valuation.totalValue).toBe(2250);
    expect(valuation.totalReturn).toBe(250);
    expect(valuation.totalReturnPct).toBeCloseTo(0.125, 6);
    expect(valuation.lines[0]).toMatchObject({ units: 10, value: 1200, unrealized: 200 });
  });

  it("flags drift only past five points", () => {
    const at = (aaa: number) =>
      valueBasket({ constituents: held, marks: marks({ AAA: [aaa, aaa, aaa], BBB: [100, 100, 100] }), cash: 0, contributed: 2000 })!;
    // 10 AAA at 110 against 10 BBB at 100 is 52.4% vs 50%.
    expect(at(110).rebalanceRecommended).toBe(false);
    // 130 vs 100 is 56.5%: 6.5 points over target.
    const flagged = at(130);
    expect(flagged.rebalanceRecommended).toBe(true);
    expect(flagged.maxAbsDrift).toBeCloseTo(0.0652, 3);
    expect(flagged.lines[0].drift).toBeGreaterThan(0);
    expect(flagged.lines[1].drift).toBeLessThan(0);
  });

  it("refuses to value a held basket with an unpriced name", () => {
    expect(valueBasket({ constituents: held, marks: marks({ AAA: [100, 99, 101] }), cash: 0, contributed: 2000 })).toBeNull();
    expect(valueBasket({ constituents: held, marks: null, cash: 0, contributed: 2000 })).toBeNull();
  });

  it("values a closed basket from cash and realized gains without prices", () => {
    const valuation = valueBasket({
      constituents: [
        { ...row("AAA", 0, 0), realizedTotal: 120 },
        { ...row("BBB", 0, 0), realizedTotal: -20 },
      ],
      marks: null,
      cash: 2100,
      contributed: 2000,
    })!;
    expect(valuation).toMatchObject({ holdingsValue: 0, realized: 100, totalValue: 2100, totalReturn: 100, rebalanceRecommended: false });
  });
});

describe("buildActionPreflight", () => {
  const input = (overrides: Partial<Parameters<typeof buildActionPreflight>[0]> = {}) => ({
    kind: "rebalance" as const,
    currency: "USD",
    account,
    constituents: [row("AAA", 20, 2000), row("BBB", 10, 1000)],
    marks: marks({ AAA: [150, 149.5, 150.5], BBB: [100, 99.5, 100.5] }),
    market: OPEN,
    guest: false,
    liveTradingEnabled: false,
    ...overrides,
  });

  it("sells the overweight name before buying the underweight one, near cash-neutral", () => {
    const plan = buildActionPreflight(input());
    expect(plan.orders.map((order) => order.action)).toEqual(["SELL", "BUY"]);
    expect(plan.orders[0]).toMatchObject({ symbol: "AAA", priceBasis: "bid", price: 149.5 });
    expect(plan.orders[1]).toMatchObject({ symbol: "BBB", priceBasis: "ask", price: 100.5 });
    expect(plan.totals.estCost).toBeLessThanOrEqual(plan.totals.sellProceeds! + 1e-6);
    expect(plan.rebalance!.maxDriftAfter).toBeLessThan(plan.rebalance!.maxDriftBefore);
    expect(plan.live.available).toBe(false);
  });

  it("prices at the last trade while the market is closed", () => {
    const plan = buildActionPreflight(input({ market: CLOSED }));
    expect(plan.orders.every((order) => order.priceBasis === "last")).toBe(true);
  });

  it("closes by selling every share", () => {
    const plan = buildActionPreflight(input({ kind: "close" }));
    expect(plan.orders.map((order) => [order.action, order.symbol, order.units])).toEqual([
      ["SELL", "AAA", 20],
      ["SELL", "BBB", 10],
    ]);
    expect(plan.totals).toMatchObject({ estCost: 0 });
    expect(plan.totals.sellProceeds).toBeCloseTo(20 * 149.5 + 10 * 99.5, 6);
  });

  it("explains why it can't plan", () => {
    const missing = () => buildActionPreflight(input({ marks: marks({ AAA: [150, 149, 151] }) }));
    expect(missing).toThrow(ActionPlanError);
    expect(missing).toThrow(/BBB/);
    const balanced = () =>
      buildActionPreflight(input({ constituents: [row("AAA", 10, 1000), row("BBB", 15, 1000)], marks: marks({ AAA: [150, 150, 150], BBB: [100, 100, 100] }) }));
    expect(balanced).toThrow(/closer to its targets/);
    expect(() => buildActionPreflight(input({ kind: "close", constituents: [row("AAA", 0, 0), row("BBB", 0, 0)] }))).toThrow(/no whole shares/);
  });
});
