import { describe, expect, it } from "vitest";

import { demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";
import { collectPortfolio } from "@/lib/thesis/portfolio";
import { MAX_CONTEXT_HOLDINGS, holdingsForContext, renderUserMessage, type ContextInput } from "@/lib/thesis/prompt";

const portfolio = collectPortfolio(
  demoOverview().accounts.map((account) => ({ account, snapshot: demoSnapshot(account.id) })),
);

const input = (overrides: Partial<ContextInput> = {}): ContextInput => ({
  prompt: "Nuclear power for AI data centers",
  budget: 2500,
  currency: "USD",
  overlapMode: "auto",
  account: { name: "Paper Trading", institution: "Alpaca Paper", isPaper: true, cash: [{ currency: "USD", amount: 48210.4 }] },
  portfolio,
  ...overrides,
});

describe("holdingsForContext", () => {
  it("merges a symbol across accounts and weights it within its currency", () => {
    const { rows, total } = holdingsForContext(portfolio);
    expect(total).toBe(20);
    const nvda = rows.find((row) => row.symbol === "NVDA");
    expect(nvda?.accounts).toEqual(["TFSA (Questrade)", "Individual (Interactive Brokers)"]);
    expect(nvda?.value).toBeCloseTo(13_132.8);
    expect(nvda?.weight).toBeCloseTo(13_132.8 / portfolio.totals.get("USD")!);
    expect(rows.some((row) => row.symbol === "CASH.TO")).toBe(false);
    expect(rows.map((row) => row.value)).toEqual([...rows.map((row) => row.value)].sort((a, b) => b - a));
  });

  it(`keeps at most ${MAX_CONTEXT_HOLDINGS} rows`, () => {
    const many = {
      ...portfolio,
      holdings: Array.from({ length: 40 }, (_, i) => ({ ...portfolio.holdings[0], symbol: `S${i}`, marketValue: 100 + i })),
    };
    const { rows, total } = holdingsForContext(many);
    expect(total).toBe(40);
    expect(rows).toHaveLength(MAX_CONTEXT_HOLDINGS);
    expect(rows[0].symbol).toBe("S39");
  });
});

describe("renderUserMessage", () => {
  it("serializes budget, account, overlap mode, holdings, cash, and the thesis", () => {
    const message = renderUserMessage(input());
    expect(message).toContain("Budget: 2,500.00 USD to invest now in whole-share market orders, all in USD.");
    expect(message).toContain("Deploying from: Paper Trading at Alpaca Paper (paper account), cash 48,210.40 USD.");
    expect(message).toContain("Overlap handling: auto-reduce.");
    expect(message).toMatch(/- CEG \(Constellation Energy Corporation\): 4,377\.00 USD, 3\.3% of USD, in Paper Trading \(Alpaca Paper\)/);
    expect(message).toContain("4,951.75 CAD in TFSA (Questrade)");
    expect(message.endsWith("<thesis>\nNuclear power for AI data centers\n</thesis>")).toBe(true);
    expect(message).not.toContain("demo with a fixed price feed");
  });

  it("restricts the demo to its price feed and says when overlap is ignored", () => {
    const message = renderUserMessage(input({ universe: ["CEG", "TLN"], overlapMode: "ignore" }));
    expect(message).toContain("Choose candidates only from these USD listings: CEG, TLN.");
    expect(message).toContain("Overlap handling: ignore.");
  });

  it("names accounts whose holdings couldn't be loaded", () => {
    const message = renderUserMessage(input({ portfolio: { ...portfolio, unavailable: ["Individual (Interactive Brokers)"] } }));
    expect(message).toContain("Holdings unavailable for: Individual (Interactive Brokers).");
  });
});
