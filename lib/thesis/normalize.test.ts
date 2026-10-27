import { describe, expect, it } from "vitest";

import { normalizeOutput, parseTicker, tickerForCurrency } from "@/lib/thesis/normalize";
import type { ThesisOutput } from "@/lib/thesis/schema";

type Candidate = ThesisOutput["candidates"][number];

const candidate = (ticker: string, weight_pct: number, overrides: Partial<Candidate> = {}): Candidate => ({
  ticker,
  listing: "US",
  company_name: `${ticker} Inc.`,
  rationale: `Why ${ticker}.`,
  weight_pct,
  holding_note: null,
  ...overrides,
});

const output = (candidates: Candidate[], overrides: Partial<ThesisOutput> = {}): ThesisOutput => ({
  on_topic: true,
  title: "Test basket",
  summary: "A test.",
  risk_profile: "moderate",
  candidates,
  excluded: [],
  ...overrides,
});

describe("parseTicker", () => {
  it("normalizes case, prefixes, suffixes, and share-class separators", () => {
    expect(parseTicker(" ceg ")).toBe("CEG");
    expect(parseTicker("$nvda")).toBe("NVDA");
    expect(parseTicker("NYSE: BRK-B")).toBe("BRK.B");
    expect(parseTicker("BRK/B")).toBe("BRK.B");
    expect(parseTicker("BRK B")).toBe("BRK.B");
    expect(parseTicker("CCJ.TO")).toBe("CCJ");
    expect(parseTicker("TSX:TECK.B")).toBe("TECK.B");
    expect(parseTicker("HPS.A")).toBe("HPS.A");
  });

  it("rejects things that aren't tickers", () => {
    expect(parseTicker("")).toBeNull();
    expect(parseTicker("Constellation Energy")).toBeNull();
    expect(parseTicker("TOOLONGTICKER")).toBeNull();
    expect(parseTicker("A.B.C.D")).toBeNull();
  });
});

describe("tickerForCurrency", () => {
  it("adds the TSX suffix for CAD baskets only", () => {
    expect(tickerForCurrency("CCJ", "CAD")).toBe("CCJ.TO");
    expect(tickerForCurrency("TECK.B", "CAD")).toBe("TECK.B.TO");
    expect(tickerForCurrency("CCJ", "USD")).toBe("CCJ");
  });
});

describe("normalizeOutput", () => {
  it("renormalizes weights to sum to 1", () => {
    const result = normalizeOutput(output([candidate("A", 30), candidate("B", 30), candidate("C", 60)]));
    expect(result.candidates.map((c) => c.weight)).toEqual([0.25, 0.25, 0.5]);
  });

  it("drops invalid tickers, duplicates, and non-positive weights, and keeps the rest", () => {
    const result = normalizeOutput(
      output([
        candidate("CEG", 20),
        candidate("ceg", 20),
        candidate("not a ticker", 20),
        candidate("VST", 0),
        candidate("ETN", Number.NaN),
        candidate("GEV", 20),
      ]),
    );
    expect(result.candidates.map((c) => c.base)).toEqual(["CEG", "GEV"]);
    expect(result.candidates.map((c) => c.weight)).toEqual([0.5, 0.5]);
    expect(result.rejected.map((r) => [r.ticker, r.status])).toEqual([
      ["ceg", "duplicate"],
      ["not a ticker", "invalid"],
      ["VST", "invalid"],
      ["ETN", "invalid"],
    ]);
  });

  it("caps the basket at 8 candidates", () => {
    const tickers = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const result = normalizeOutput(output(tickers.map((t) => candidate(t, 10))));
    expect(result.candidates).toHaveLength(8);
    expect(result.rejected).toEqual([expect.objectContaining({ ticker: "I", status: "invalid" })]);
  });

  it("clamps long text and collapses whitespace", () => {
    const result = normalizeOutput(
      output([candidate("CEG", 100, { rationale: `  Nuclear\n\n${"x".repeat(300)}`, holding_note: "  Held   in TFSA " })], {
        excluded: [{ ticker: " vst ", reason: "Already held." }],
      }),
    );
    const [line] = result.candidates;
    expect(line.rationale.length).toBeLessThanOrEqual(200);
    expect(line.rationale.startsWith("Nuclear x")).toBe(true);
    expect(line.rationale.endsWith("…")).toBe(true);
    expect(line.holdingNote).toBe("Held in TFSA");
    expect(result.excluded).toEqual([{ ticker: "VST", reason: "Already held." }]);
  });

  it("passes through an off-topic verdict", () => {
    expect(normalizeOutput(output([], { on_topic: false })).onTopic).toBe(false);
  });
});
