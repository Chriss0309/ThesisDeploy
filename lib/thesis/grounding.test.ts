import type { SymbolsQuotesInner } from "snaptrade-typescript-sdk";
import { describe, expect, it, vi } from "vitest";

import { QuoteBatchRejectedError, groundCandidates, type QuoteSource } from "@/lib/thesis/grounding";
import type { ProposedCandidate } from "@/lib/thesis/normalize";
import { DEMO_QUOTES, demoQuoteSource, searchQuotes } from "@/lib/thesis/quote-sources";

const proposal = (base: string, overrides: Partial<ProposedCandidate> = {}): ProposedCandidate => ({
  ticker: base,
  base,
  listing: "US",
  companyName: base,
  rationale: "",
  weight: 0.25,
  holdingNote: null,
  ...overrides,
});

/** The demo feed, with call counters and an optional whole-batch rejection. */
function countingSource({ rejectUnknown = false } = {}) {
  const demo = demoQuoteSource();
  const quotes = vi.fn(async (tickers: string[]) => {
    const found = await demo.quotes(tickers);
    if (rejectUnknown && found.length < tickers.length) throw new QuoteBatchRejectedError("unknown ticker");
    return found;
  });
  const search = vi.fn(demo.search);
  const source: QuoteSource = { kind: "demo", quotes, search };
  return { source, quotes, search };
}

const byBase = (result: Awaited<ReturnType<typeof groundCandidates>>) =>
  Object.fromEntries(result.candidates.map((c) => [c.base, c]));

describe("groundCandidates", () => {
  it("resolves a USD basket with one batched quotes call and no searches", async () => {
    const { source, quotes, search } = countingSource();
    const result = await groundCandidates([proposal("CEG"), proposal("TLN"), proposal("BRK.B")], "USD", source);
    expect(result.candidates.map((c) => c.status)).toEqual(["resolved", "resolved", "resolved"]);
    expect(quotes).toHaveBeenCalledTimes(1);
    expect(quotes).toHaveBeenCalledWith(["CEG", "TLN", "BRK.B"]);
    expect(search).not.toHaveBeenCalled();
    expect(byBase(result).CEG.symbol).toMatchObject({ symbol: "CEG", currency: "USD", typeCode: "cs", shareClassFigi: "DEMO-CEG" });
    expect(byBase(result).CEG.quote).toEqual({ last: 291.8, bid: 291.68, ask: 291.92 });
  });

  it("asks for TSX listings in a CAD basket", async () => {
    const { source, quotes } = countingSource();
    const result = await groundCandidates([proposal("CCJ"), proposal("TECK.B", { listing: "TSX" })], "CAD", source);
    expect(quotes).toHaveBeenCalledWith(["CCJ.TO", "TECK.B.TO"]);
    expect(result.candidates.map((c) => [c.symbol?.symbol, c.status])).toEqual([
      ["CCJ.TO", "resolved"],
      ["TECK.B.TO", "resolved"],
    ]);
  });

  it("drops ETFs as untradeable", async () => {
    const { source } = countingSource();
    const result = await groundCandidates([proposal("URA")], "USD", source);
    expect(result.candidates[0]).toMatchObject({ status: "untradeable", detail: expect.stringContaining("ETF") });
  });

  it("searches misses: unknown tickers are not found, other-currency listings are a currency mismatch", async () => {
    const { source, search } = countingSource();
    const result = await groundCandidates([proposal("SMR"), proposal("CEG"), proposal("CNR", { listing: "TSX" })], "CAD", source);
    expect(search.mock.calls.map(([query]) => query)).toEqual(["SMR", "CEG"]);
    const grounded = byBase(result);
    expect(grounded.SMR).toMatchObject({ status: "not_found", detail: "SnapTrade doesn't recognize SMR.TO" });
    expect(grounded.CEG).toMatchObject({ status: "currency_mismatch", detail: expect.stringContaining("Listed as CEG in USD") });
    expect(grounded.CNR.status).toBe("resolved");
  });

  it("falls back to search and one re-quote when SnapTrade rejects the whole batch", async () => {
    const { source, quotes, search } = countingSource({ rejectUnknown: true });
    const result = await groundCandidates([proposal("CEG"), proposal("SMR"), proposal("VST")], "USD", source);
    expect(search).toHaveBeenCalledTimes(3);
    expect(quotes).toHaveBeenCalledTimes(2);
    expect(quotes.mock.calls[1][0]).toEqual(["CEG", "VST"]);
    expect(result.candidates.map((c) => c.status)).toEqual(["resolved", "not_found", "resolved"]);
    expect(result.quoteCalls).toBe(2);
  });

  it("reports a symbol SnapTrade knows but didn't quote as having no price", async () => {
    const quotes = async () => [] as SymbolsQuotesInner[];
    const source: QuoteSource = { kind: "demo", quotes, search: async (q) => searchQuotes(DEMO_QUOTES.quotes, q) };
    const result = await groundCandidates([proposal("CEG")], "USD", source);
    expect(result.candidates[0]).toMatchObject({ status: "no_price", symbol: { symbol: "CEG" } });
  });

  it("flags two proposals for the same listing as duplicates", async () => {
    const { source, quotes } = countingSource();
    const result = await groundCandidates(
      [proposal("CCJ"), proposal("CCJ", { ticker: "CCJ.TO", listing: "TSX" })],
      "CAD",
      source,
    );
    expect(quotes).toHaveBeenCalledWith(["CCJ.TO"]);
    expect(result.candidates.map((c) => c.status)).toEqual(["resolved", "duplicate"]);
  });

  it("refuses more candidates than one quotes call can hold", async () => {
    const { source } = countingSource();
    const many = Array.from({ length: 11 }, (_, i) => proposal(`ZZ${i}`));
    await expect(groundCandidates(many, "USD", source)).rejects.toThrow(RangeError);
  });

  it("drops quotes with no positive price", async () => {
    const [ceg] = DEMO_QUOTES.quotes;
    const source: QuoteSource = {
      kind: "demo",
      quotes: async () => [{ ...ceg, last_trade_price: 0, bid_price: 0, ask_price: 0 }],
      search: async () => [],
    };
    const result = await groundCandidates([proposal("CEG")], "USD", source);
    expect(result.candidates[0].status).toBe("no_price");
  });

  it("propagates errors other than a batch rejection", async () => {
    const source: QuoteSource = {
      kind: "demo",
      quotes: async () => {
        throw new Error("rate limited");
      },
      search: async () => [],
    };
    await expect(groundCandidates([proposal("CEG")], "USD", source)).rejects.toThrow("rate limited");
  });
});
