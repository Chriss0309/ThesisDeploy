import { describe, expect, it } from "vitest";

import { concentrationByCurrency } from "@/lib/portfolio/concentration";
import { demoSnapshot } from "@/lib/portfolio/fixtures";
import type { AccountSnapshot, Holding } from "@/lib/portfolio/types";

const holding = (symbol: string, marketValue: number | null, overrides: Partial<Holding> = {}): Holding => ({
  symbol,
  description: null,
  kind: "stock",
  currency: "USD",
  units: 1,
  price: marketValue,
  marketValue,
  cashEquivalent: false,
  figiShareClass: null,
  ...overrides,
});

const snapshot = (holdings: Holding[], balances: AccountSnapshot["balances"]): AccountSnapshot => ({
  accountId: "a",
  holdings,
  balances,
  dataAsOf: null,
  fetchedAt: "2026-10-26T00:00:00Z",
});

describe("concentrationByCurrency", () => {
  it("builds one bar per currency without mixing CAD and USD", () => {
    const bars = concentrationByCurrency(demoSnapshot("demo-acct-tfsa")!);
    expect(bars.map((bar) => bar.currency)).toEqual(["CAD", "USD"]);
    for (const bar of bars) {
      expect(bar.segments.reduce((sum, segment) => sum + segment.weight, 0)).toBeCloseTo(1);
    }
    const usd = bars[1];
    expect(usd.total).toBeCloseTo(2188.8 + 1672.8 + 812.3);
    expect(usd.segments.map((segment) => segment.label)).toEqual(["NVDA", "MSFT", "Cash"]);
  });

  it("shows the top five, groups the rest, and doesn't double-count cash equivalents", () => {
    const cad = concentrationByCurrency(demoSnapshot("demo-acct-tfsa")!)[0];
    expect(cad.segments.map((segment) => segment.label)).toEqual([
      "ENB.TO",
      "XEQT.TO",
      "RY.TO",
      "CCJ.TO",
      "SU.TO",
      "1 other",
      "Cash",
    ]);
    // CASH.TO (cash_equivalent) is inside the 4951.75 cash balance already.
    expect(cad.total).toBeCloseTo(27890 + 4951.75);
    expect(cad.weights.has("CASH.TO")).toBe(false);
  });

  it("leaves out shorts, unpriced holdings, and negative margin cash", () => {
    const [bar] = concentrationByCurrency(
      snapshot(
        [holding("LONG", 300), holding("SHORT", -100), holding("UNPRICED", null)],
        [{ currency: "USD", cash: -50, buyingPower: 200 }],
      ),
    );
    expect(bar.segments).toEqual([{ label: "LONG", value: 300, weight: 1, kind: "holding" }]);
  });

  it("assigns holdings without a currency to the account's only cash currency", () => {
    const [bar] = concentrationByCurrency(
      snapshot([holding("X", 100, { currency: null })], [{ currency: "CAD", cash: 100, buyingPower: 100 }]),
    );
    expect(bar).toMatchObject({ currency: "CAD", total: 200 });
  });

  it("returns nothing for an empty account", () => {
    expect(concentrationByCurrency(snapshot([], [{ currency: "USD", cash: 0, buyingPower: 0 }]))).toEqual([]);
  });
});
