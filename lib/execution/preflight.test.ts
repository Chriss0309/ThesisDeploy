import { describe, expect, it } from "vitest";

import { buildPreflight, buyPrice, marketNote, type PreflightInput } from "@/lib/execution/preflight";
import { marketStatus } from "@/lib/market-hours";

const OPEN = marketStatus("NYSE", new Date("2026-10-27T15:00:00Z"));
const WEEKEND = marketStatus("NYSE", new Date("2026-10-24T16:00:00Z"));

const input = (overrides: Partial<PreflightInput> = {}): PreflightInput => ({
  lines: [
    { symbol: "VST", companyName: "Vistra", universalSymbolId: "u1", targetWeight: 0.4, units: 4 },
    { symbol: "ETN", companyName: "Eaton", universalSymbolId: "u2", targetWeight: 0.4, units: 2 },
    { symbol: "CEG", companyName: "Constellation", universalSymbolId: "u3", targetWeight: 0, units: 0 },
    { symbol: "OKLO", companyName: "Oklo", universalSymbolId: "u4", targetWeight: 0.2, units: 3 },
  ],
  quotes: new Map([
    ["VST", { last: 150, bid: 149.9, ask: 150.1 }],
    ["ETN", { last: 340, bid: 339, ask: 341 }],
  ]),
  market: OPEN,
  budget: 1500,
  currency: "USD",
  account: {
    id: "acct",
    name: "Paper Trading",
    institution: "Alpaca Paper",
    isPaper: true,
    capability: "trade",
    capabilityReason: "Trading enabled",
  },
  buyingPower: 10_000,
  killSwitch: { on: false, preview: false },
  guest: false,
  priceSource: "snaptrade",
  ...overrides,
});

describe("buyPrice", () => {
  it("uses the ask while open and the last trade while closed", () => {
    expect(buyPrice({ last: 10, ask: 10.5 }, true)).toEqual({ price: 10.5, basis: "ask" });
    expect(buyPrice({ last: 10, ask: 10.5 }, false)).toEqual({ price: 10, basis: "last" });
    expect(buyPrice({ last: 0, ask: 10.5 }, false)).toEqual({ price: 10.5, basis: "ask" });
    expect(buyPrice({ last: null, ask: 0 }, true)).toBeNull();
  });
});

describe("buildPreflight", () => {
  it("lists the exact orders, renumbered, and explains every line left out", () => {
    const result = buildPreflight(input());
    expect(result.orders.map((order) => [order.seq, order.symbol, order.units, order.price, order.priceBasis])).toEqual([
      [1, "VST", 4, 150.1, "ask"],
      [2, "ETN", 2, 341, "ask"],
    ]);
    expect(result.orders.map((order) => order.targetWeight)).toEqual([0.5, 0.5]);
    expect(result.leftOut).toEqual([
      { symbol: "CEG", reason: "0 shares in the composer" },
      { symbol: "OKLO", reason: "SnapTrade returned no price" },
    ]);
    expect(result.totals).toEqual({ estCost: 4 * 150.1 + 2 * 341, unallocated: 1500 - (4 * 150.1 + 2 * 341), overBudget: false });
  });

  it("keeps Live unavailable with a reason for each blocker, while Paper always works", () => {
    const result = buildPreflight(
      input({ market: WEEKEND, account: { ...input().account, capability: "read_only", capabilityReason: "Read-only connection" } }),
    );
    expect(result.live).toMatchObject({
      available: false,
      reasons: [
        "Live trading is switched off on this deployment.",
        "Read-only connection",
        "NYSE is closed (weekend), and Live market orders are blocked outside the regular session. Opens Mon, Oct 26, 9:30 AM ET.",
      ],
    });
    expect(result.orders[0].priceBasis).toBe("last");
  });

  it("opens Live when every gate passes, and checks buying power only then", () => {
    const on = { killSwitch: { on: true, preview: false } };
    expect(buildPreflight(input(on)).live).toMatchObject({ available: true, reasons: [] });
    expect(buildPreflight(input({ ...on, buyingPower: 100 })).live.reasons).toEqual([
      "The orders need about $1,282.40 USD; the account has $100.00 USD of buying power.",
    ]);
    expect(buildPreflight(input({ ...on, buyingPower: null })).live.reasons).toEqual([
      "This account's USD buying power couldn't be confirmed.",
    ]);
    expect(buildPreflight(input({ killSwitch: { on: false, preview: true } })).live.reasons).toEqual([
      "Live trading is always off on preview deployments.",
    ]);
  });

  it("says demo accounts are fictional", () => {
    const demo = buildPreflight(input({ guest: true, priceSource: "demo", quotes: new Map() }));
    expect(demo.live.reasons[0]).toContain("Demo accounts are fictional");
    expect(demo.leftOut.map((line) => line.reason)).toContain("No demo quote");
  });

  it("uses SnapTrade's estimate disclaimer for Live", () => {
    const result = buildPreflight(input());
    expect(result.disclosures.live[0]).toMatch(/^Estimated results\. The amounts shown are estimates only/);
    expect(result.disclosures.live.join(" ")).toContain("including when estimated commissions are $0.00");
    expect(result.impactNote).toContain("no brokerage order preview");
  });
});

describe("marketNote", () => {
  it("names the reason and the next open", () => {
    expect(marketNote(OPEN)).toBe("NYSE is open: buys are priced at the ask.");
    expect(marketNote(WEEKEND)).toBe("NYSE is closed (weekend): prices are the last trade. Opens Mon, Oct 26, 9:30 AM ET.");
  });
});
