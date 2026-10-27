import { describe, expect, it } from "vitest";

import { DEMO_FIXTURES, demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";
import { normalizeAccounts, normalizeSnapshot } from "@/lib/portfolio/normalize";

describe("normalizeAccounts", () => {
  it("lists investment accounts with institution and capability, hiding other kinds", () => {
    const overview = demoOverview();
    expect(overview.hiddenAccounts).toBe(1);
    expect(
      overview.accounts.map(({ id, institution, capability, isPaper }) => ({ id, institution, capability, isPaper })),
    ).toEqual([
      { id: "demo-acct-tfsa", institution: "Questrade", capability: "trade", isPaper: false },
      { id: "demo-acct-alpaca-paper", institution: "Alpaca Paper", capability: "trade", isPaper: true },
      { id: "demo-acct-ibkr", institution: "Interactive Brokers", capability: "read_only", isPaper: false },
      { id: "demo-acct-wealthsimple", institution: "Wealthsimple", capability: "disabled", isPaper: false },
    ]);
    expect(overview.accounts[2].capabilityReason).toBe("Read-only connection");
    expect(overview.accounts[0]).toMatchObject({
      maskedNumber: "****4821",
      cashOrMargin: "cash",
      netValue: { amount: 39291.75, currency: "CAD" },
    });
  });

  it("is read-only everywhere when the grant lacks the trade scope", () => {
    const overview = normalizeAccounts(DEMO_FIXTURES.connections, DEMO_FIXTURES.accounts, ["openid", "read"]);
    const tfsa = overview.accounts.find((account) => account.id === "demo-acct-tfsa");
    expect(tfsa).toMatchObject({
      capability: "read_only",
      capabilityReason: "Trading wasn't authorized for ThesisDeploy",
    });
  });

  it("respects a brokerage that doesn't allow trading and a missing connection", () => {
    const [questrade] = DEMO_FIXTURES.connections;
    const overview = normalizeAccounts(
      [{ ...questrade, brokerage: { ...questrade.brokerage, allows_trading: false } }],
      DEMO_FIXTURES.accounts,
      ["read", "trade"],
    );
    expect(overview.accounts.find((a) => a.id === "demo-acct-tfsa")?.capability).toBe("read_only");
    expect(overview.accounts.find((a) => a.id === "demo-acct-ibkr")).toMatchObject({
      capability: "read_only",
      institution: "Unknown brokerage",
    });
  });
});

describe("normalizeSnapshot", () => {
  it("parses SnapTrade's string units and prices and sorts by market value", () => {
    const snapshot = demoSnapshot("demo-acct-tfsa");
    expect(snapshot?.balances).toEqual([
      { currency: "CAD", cash: 4951.75, buyingPower: 4951.75 },
      { currency: "USD", cash: 812.3, buyingPower: 812.3 },
    ]);
    expect(snapshot?.holdings[0]).toMatchObject({ symbol: "ENB.TO", units: 120, price: 57.85 });
    expect(snapshot?.holdings[0].marketValue).toBeCloseTo(6942);
    expect(snapshot?.holdings.find((h) => h.symbol === "CASH.TO")?.cashEquivalent).toBe(true);
    expect(snapshot?.dataAsOf).toBe("2026-10-26T13:30:00.000Z");
  });

  it("keeps positions with unparseable or missing numbers instead of dropping them", () => {
    const [position] = DEMO_FIXTURES.positions["demo-acct-ibkr"].results;
    const snapshot = normalizeSnapshot(
      "x",
      [{ currency: { code: "USD" }, cash: null, buying_power: undefined }, { cash: 5 }],
      { results: [{ ...position, units: "abc", price: null }], data_freshness: { as_of: "2026-10-26T00:00:00Z" } },
      new Date("2026-10-26T01:00:00Z"),
    );
    expect(snapshot.balances).toEqual([{ currency: "USD", cash: null, buyingPower: null }]);
    expect(snapshot.holdings[0]).toMatchObject({ units: 0, price: null, marketValue: null });
  });
});
