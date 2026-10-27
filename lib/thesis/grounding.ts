import type { SymbolsQuotesInner, UniversalSymbol } from "snaptrade-typescript-sdk";

import { executionPrice } from "@/lib/solver";
import { tickerForCurrency, type ProposedCandidate } from "@/lib/thesis/normalize";
import type { BasketCurrency } from "@/lib/thesis/schema";
import type { CandidateStatus, QuoteSnapshot } from "@/lib/thesis/types";

/** SnapTrade's getUserAccountQuotes accepts at most 10 symbols per call. */
export const MAX_QUOTE_SYMBOLS = 10;
/** Common stock and ADRs. ETFs and everything else are out of the universe. */
const TRADEABLE_TYPES = new Set(["cs", "ad"]);

/**
 * Where grounding gets symbols and prices: SnapTrade for signed-in users, the
 * demo fixture for guests. `quotes` throws QuoteBatchRejectedError when the
 * whole batch is refused (for example, because one ticker is unknown).
 */
export type QuoteSource = {
  kind: "snaptrade" | "demo";
  quotes(tickers: string[]): Promise<SymbolsQuotesInner[]>;
  search(query: string): Promise<UniversalSymbol[]>;
};

export class QuoteBatchRejectedError extends Error {
  name = "QuoteBatchRejectedError";
}

export type ResolvedSymbol = {
  id: string;
  symbol: string;
  rawSymbol: string;
  description: string | null;
  currency: string | null;
  exchange: string | null;
  typeCode: string | null;
  figiCode: string | null;
  shareClassFigi: string | null;
};

export type GroundedCandidate = ProposedCandidate & {
  queryTicker: string;
  status: CandidateStatus;
  /** Why a candidate was dropped, for the composer and the audit trail. */
  detail: string | null;
  symbol: ResolvedSymbol | null;
  quote: QuoteSnapshot | null;
};

export type GroundingResult = {
  candidates: GroundedCandidate[];
  quoteCalls: number;
  searchCalls: number;
};

function toResolved(symbol: UniversalSymbol): ResolvedSymbol {
  return {
    id: symbol.id,
    symbol: symbol.symbol,
    rawSymbol: symbol.raw_symbol ?? symbol.symbol,
    description: symbol.description ?? null,
    currency: symbol.currency?.code ?? null,
    exchange: symbol.exchange?.code ?? null,
    typeCode: symbol.type?.code ?? null,
    figiCode: symbol.figi_code ?? symbol.figi_instrument?.figi_code ?? null,
    shareClassFigi: symbol.figi_instrument?.figi_share_class ?? null,
  };
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function toQuote(quote: SymbolsQuotesInner): QuoteSnapshot {
  return {
    last: positive(quote.last_trade_price),
    bid: positive(quote.bid_price),
    ask: positive(quote.ask_price),
  };
}

const typeLabel = (symbol: ResolvedSymbol) =>
  symbol.typeCode === "et" ? "an ETF" : `security type "${symbol.typeCode ?? "unknown"}"`;

/** Applies the universe rules to a symbol SnapTrade returned for the requested ticker. */
function classify(
  symbol: ResolvedSymbol,
  quote: QuoteSnapshot | null,
  currency: BasketCurrency,
): Pick<GroundedCandidate, "status" | "detail"> {
  if (!symbol.typeCode || !TRADEABLE_TYPES.has(symbol.typeCode)) {
    return { status: "untradeable", detail: `${symbol.symbol} is ${typeLabel(symbol)}; baskets hold stocks and ADRs` };
  }
  if (symbol.currency !== currency) {
    return { status: "currency_mismatch", detail: `${symbol.symbol} trades in ${symbol.currency ?? "an unknown currency"}` };
  }
  if (!quote || executionPrice(quote, "buy") == null) {
    return { status: "no_price", detail: `SnapTrade returned no price for ${symbol.symbol}` };
  }
  return { status: "resolved", detail: null };
}

/**
 * Resolves each candidate to a SnapTrade symbol and price in the basket
 * currency. One batched quotes call covers every candidate (it is the only
 * call here that counts against the account's rate limit). Misses go to
 * symbol search, which needs an exact ticker match: a match in the right
 * currency means the quote was missing, a listing in another currency is a
 * currency mismatch, and no match means SnapTrade doesn't know the ticker.
 * If SnapTrade rejects the whole batch, every candidate is searched and the
 * confirmed tickers are quoted once more.
 */
export async function groundCandidates(
  proposed: readonly ProposedCandidate[],
  currency: BasketCurrency,
  source: QuoteSource,
): Promise<GroundingResult> {
  const candidates: GroundedCandidate[] = [];
  const pending: GroundedCandidate[] = [];
  const queried = new Set<string>();
  for (const candidate of proposed) {
    const queryTicker = tickerForCurrency(candidate.base, currency);
    const grounded: GroundedCandidate = {
      ...candidate,
      queryTicker,
      status: "not_found",
      detail: null,
      symbol: null,
      quote: null,
    };
    candidates.push(grounded);
    if (queried.has(queryTicker)) {
      Object.assign(grounded, { status: "duplicate", detail: `Same listing as another candidate (${queryTicker})` });
      continue;
    }
    queried.add(queryTicker);
    pending.push(grounded);
  }
  if (pending.length > MAX_QUOTE_SYMBOLS) {
    throw new RangeError(`at most ${MAX_QUOTE_SYMBOLS} candidates can be quoted at once`);
  }

  let quoteCalls = 0;
  let searchCalls = 0;
  const fetchQuotes = async (tickers: string[]) => {
    quoteCalls++;
    const quotes = await source.quotes(tickers);
    return new Map(
      quotes
        .filter((quote) => quote.symbol?.symbol)
        .map((quote) => [quote.symbol!.symbol.toUpperCase(), quote] as const),
    );
  };

  let quotes = new Map<string, SymbolsQuotesInner>();
  let batchRejected = false;
  if (pending.length > 0) {
    try {
      quotes = await fetchQuotes(pending.map((candidate) => candidate.queryTicker));
    } catch (error) {
      if (!(error instanceof QuoteBatchRejectedError)) throw error;
      batchRejected = true;
    }
  }

  const misses: GroundedCandidate[] = [];
  for (const candidate of pending) {
    const quote = quotes.get(candidate.queryTicker);
    if (!quote?.symbol) {
      misses.push(candidate);
      continue;
    }
    candidate.symbol = toResolved(quote.symbol);
    candidate.quote = toQuote(quote);
    Object.assign(candidate, classify(candidate.symbol, candidate.quote, currency));
  }

  const requote: GroundedCandidate[] = [];
  for (const candidate of misses) {
    searchCalls++;
    const results = (await source.search(candidate.base)).map(toResolved);
    const exact = results.find((symbol) => symbol.symbol.toUpperCase() === candidate.queryTicker);
    const otherListing = results.find((symbol) => symbol.rawSymbol.toUpperCase() === candidate.base);
    if (exact) {
      candidate.symbol = exact;
      const verdict = classify(exact, null, currency);
      if (verdict.status === "no_price" && batchRejected) requote.push(candidate);
      Object.assign(candidate, verdict);
    } else if (otherListing) {
      Object.assign(candidate, {
        status: "currency_mismatch",
        detail: `Listed as ${otherListing.symbol} in ${otherListing.currency ?? "another currency"}; no ${currency} listing`,
      });
    } else {
      candidate.detail = `SnapTrade doesn't recognize ${candidate.queryTicker}`;
    }
  }

  if (requote.length > 0) {
    const retried = await fetchQuotes(requote.map((candidate) => candidate.queryTicker));
    for (const candidate of requote) {
      const quote = retried.get(candidate.queryTicker);
      if (!quote?.symbol) continue;
      candidate.symbol = toResolved(quote.symbol);
      candidate.quote = toQuote(quote);
      Object.assign(candidate, classify(candidate.symbol, candidate.quote, currency));
    }
  }

  // Distinct tickers can still be one share class; keep the first.
  const companies = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.status !== "resolved" || !candidate.symbol) continue;
    const key = candidate.symbol.shareClassFigi ?? candidate.symbol.id;
    if (companies.has(key)) {
      Object.assign(candidate, { status: "duplicate", detail: "Same company as another candidate" });
    }
    companies.add(key);
  }

  return { candidates, quoteCalls, searchCalls };
}
