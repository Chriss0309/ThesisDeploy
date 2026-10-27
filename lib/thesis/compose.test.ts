import { describe, expect, it } from "vitest";

import { demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";
import { composeBasket } from "@/lib/thesis/compose";
import { groundCandidates } from "@/lib/thesis/grounding";
import type { ProposedCandidate } from "@/lib/thesis/normalize";
import { collectPortfolio } from "@/lib/thesis/portfolio";
import { demoQuoteSource } from "@/lib/thesis/quote-sources";
import type { BasketCurrency, OverlapMode } from "@/lib/thesis/schema";

const portfolio = collectPortfolio(
  demoOverview().accounts.map((account) => ({ account, snapshot: demoSnapshot(account.id) })),
);

const proposal = (base: string, weight: number): ProposedCandidate => ({
  ticker: base,
  base,
  listing: "US",
  companyName: base,
  rationale: `Why ${base}.`,
  weight,
  holdingNote: null,
});

async function compose(
  bases: [string, number][],
  { budget = 2500, currency = "USD", overlapMode = "auto", marketOpen = false }: {
    budget?: number;
    currency?: BasketCurrency;
    overlapMode?: OverlapMode;
    marketOpen?: boolean;
  } = {},
) {
  const { candidates } = await groundCandidates(
    bases.map(([base, weight]) => proposal(base, weight)),
    currency,
    demoQuoteSource(),
  );
  return composeBasket({ candidates, portfolio, budget, currency, overlapMode, marketOpen });
}

const bySymbol = (lines: { symbol: string }[]) => Object.fromEntries(lines.map((line) => [line.symbol, line]));

describe("composeBasket", () => {
  it("skips names held at target, keeps other-currency holdings uncounted, and sizes whole shares", async () => {
    const result = await compose([
      ["CEG", 0.25],
      ["TLN", 0.25],
      ["CCJ", 0.25],
      ["PWR", 0.25],
    ]);
    const lines = bySymbol(result.lines);

    // Paper Trading holds $4,377 of CEG, above its $625 target.
    expect(lines.CEG.overlap.status).toBe("fully_held");
    expect(lines.CEG.overlap.heldValue).toBeCloseTo(4377);
    expect(lines.CEG.targetWeight).toBe(0);
    expect(lines.CEG.units).toBe(0);
    // TFSA holds CCJ.TO in CAD: same share class, but there's no FX rate.
    expect(lines.CCJ.overlap.status).toBe("unconverted");
    expect(lines.CCJ.overlap.holdings).toEqual([
      expect.objectContaining({ symbol: "CCJ.TO", currency: "CAD", counted: false }),
    ]);
    expect(lines.TLN.overlap.status).toBe("new");
    expect(lines.TLN.targetWeight).toBeCloseTo(1 / 3);

    // Market closed: priced at the last trade. B_eff = 2,462.50; 820.83 per name.
    expect(lines.TLN).toMatchObject({ price: 342.5, priceBasis: "last", units: 2 });
    expect(lines.CCJ).toMatchObject({ price: 71.4, units: 11 });
    expect(lines.PWR).toMatchObject({ price: 361.9, units: 2 });
    expect(result.allocation.invested).toBeCloseTo(2194.2);
  });

  it("buys only the gap for a partly held name", async () => {
    const result = await compose(
      [
        ["VST", 0.25],
        ["TLN", 0.25],
        ["BWXT", 0.25],
        ["PWR", 0.25],
      ],
      { budget: 100_000 },
    );
    const vst = bySymbol(result.lines).VST;
    // Target $25,000, held $6,730: buy $18,270 of the $93,270 total gap.
    expect(vst.overlap.status).toBe("adjusted");
    expect(vst.llmWeight).toBe(0.25);
    expect(vst.targetWeight).toBeCloseTo(18_270 / 93_270);
    expect(vst.overlap.heldShare).toBeCloseTo(6730 / portfolio.totals.get("USD")!);
    expect(vst.overlap.holdings).toEqual([
      expect.objectContaining({ accountName: "Paper Trading (Alpaca Paper)", counted: true }),
    ]);
  });

  it("reports overlap without reweighting in ignore mode", async () => {
    const result = await compose(
      [
        ["CEG", 0.5],
        ["TLN", 0.5],
      ],
      { overlapMode: "ignore" },
    );
    expect(bySymbol(result.lines).CEG).toMatchObject({ targetWeight: 0.5, overlap: { status: "ignored" } });
  });

  it("buys at the ask while the market is open", async () => {
    const result = await compose([["TLN", 1]], { marketOpen: true });
    expect(result.lines[0]).toMatchObject({ price: 342.64, priceBasis: "ask" });
  });

  it("lists dropped candidates under the ticker that was looked up", async () => {
    const result = await compose(
      [
        ["CCJ", 0.5],
        ["CEG", 0.5],
      ],
      { currency: "CAD", budget: 1000 },
    );
    expect(result.lines.map((line) => line.symbol)).toEqual(["CCJ.TO"]);
    expect(result.dropped).toEqual([
      expect.objectContaining({ ticker: "CEG.TO", status: "currency_mismatch" }),
    ]);
    // TFSA holds C$3,444 of CCJ.TO, above a C$1,000 basket's whole budget.
    expect(result.lines[0].overlap.status).toBe("fully_held");
  });
});
