import type { SymbolsQuotesInner, UniversalSymbol } from "snaptrade-typescript-sdk";

import type { PortfolioAccount } from "@/lib/portfolio/types";
import { SnapTradeError, callSnapTrade, type SnapTradeContext } from "@/lib/snaptrade/client";
import raw from "@/lib/thesis/demo-quotes.json";
import { QuoteBatchRejectedError, type QuoteSource } from "@/lib/thesis/grounding";
import type { BasketCurrency } from "@/lib/thesis/schema";

/**
 * Quotes are account-scoped and count against the account's 10/minute limit,
 * so they go through the shared budget. Symbol search is not on SnapTrade's
 * list of account-limited endpoints and is called without `accountId`, so it
 * is recorded in api_calls but doesn't spend the account's budget.
 */
export function snapTradeQuoteSource(ctx: SnapTradeContext, account: PortfolioAccount): QuoteSource {
  return {
    kind: "snaptrade",
    async quotes(tickers) {
      try {
        return await callSnapTrade(
          ctx,
          "getUserAccountQuotes",
          (api) =>
            api.trading.getUserAccountQuotes({ accountId: account.id, symbols: tickers.join(","), useTicker: true }),
          { accountId: account.id, brokerageSlug: account.brokerageSlug },
        );
      } catch (error) {
        // The docs don't say whether an unknown ticker is omitted or fails the batch.
        if (error instanceof SnapTradeError && error.code === "upstream" && [400, 404, 422].includes(error.status ?? 0)) {
          throw new QuoteBatchRejectedError(`quotes batch rejected with HTTP ${error.status}`, { cause: error });
        }
        throw error;
      }
    },
    search: (query) =>
      callSnapTrade(
        ctx,
        "symbolSearchUserAccount",
        (api) => api.referenceData.symbolSearchUserAccount({ accountId: account.id, substring: query }),
        { brokerageSlug: account.brokerageSlug },
      ),
  };
}

export const DEMO_QUOTES = raw as unknown as { as_of: string; quotes: SymbolsQuotesInner[] };

const TRADEABLE = new Set(["cs", "ad"]);

/** Ticker or name match, exact tickers first, at most 20 results (like SnapTrade). */
export function searchQuotes(quotes: readonly SymbolsQuotesInner[], query: string): UniversalSymbol[] {
  const needle = query.trim().toUpperCase();
  if (!needle) return [];
  const symbols = quotes.flatMap((quote) => (quote.symbol ? [quote.symbol] : []));
  const rank = (symbol: UniversalSymbol) =>
    symbol.symbol.toUpperCase() === needle || symbol.raw_symbol?.toUpperCase() === needle
      ? 0
      : symbol.symbol.toUpperCase().startsWith(needle)
        ? 1
        : 2;
  return symbols
    .filter((symbol) => rank(symbol) < 2 || symbol.description?.toUpperCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 20);
}

export function demoQuoteSource(): QuoteSource {
  const bySymbol = new Map(DEMO_QUOTES.quotes.map((quote) => [quote.symbol?.symbol.toUpperCase(), quote]));
  return {
    kind: "demo",
    quotes: async (tickers) =>
      tickers.flatMap((ticker) => {
        const quote = bySymbol.get(ticker.toUpperCase());
        return quote ? [quote] : [];
      }),
    search: async (query) => searchQuotes(DEMO_QUOTES.quotes, query),
  };
}

/** Stocks and ADRs the demo can price in one currency, for the demo prompt. */
export function demoUniverse(currency: BasketCurrency): string[] {
  return DEMO_QUOTES.quotes
    .flatMap((quote) => (quote.symbol ? [quote.symbol] : []))
    .filter((symbol) => symbol.currency?.code === currency && TRADEABLE.has(symbol.type?.code ?? ""))
    .map((symbol) => symbol.raw_symbol ?? symbol.symbol)
    .sort();
}
