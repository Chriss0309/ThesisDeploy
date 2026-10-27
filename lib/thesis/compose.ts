import { adjustForOverlap } from "@/lib/overlap";
import { DEFAULT_SLIPPAGE_BUFFER, executionPrice, solveWholeShares, type Allocation } from "@/lib/solver";
import type { GroundedCandidate } from "@/lib/thesis/grounding";
import type { PortfolioView } from "@/lib/thesis/portfolio";
import type { BasketCurrency, OverlapMode } from "@/lib/thesis/schema";
import type { ComposerLine, DroppedCandidate, QuoteSnapshot } from "@/lib/thesis/types";

export type ComposeInput = {
  candidates: readonly GroundedCandidate[];
  portfolio: PortfolioView;
  budget: number;
  currency: BasketCurrency;
  overlapMode: OverlapMode;
  marketOpen: boolean;
};

export type Composition = {
  lines: ComposerLine[];
  dropped: DroppedCandidate[];
  allocation: Allocation;
};

// Mirrors executionPrice's order for buys.
function priceBasis(quote: QuoteSnapshot, marketOpen: boolean): "ask" | "last" {
  if (marketOpen) return quote.ask != null ? "ask" : "last";
  return quote.last != null ? "last" : "ask";
}

/**
 * Deterministic sizing; Claude only advises. The top-up overlap rule
 * reweights the resolved names against holdings across every account
 * (same currency only, since there is no FX source), then the whole-share
 * solver sizes them at the buy-side price.
 */
export function composeBasket(input: ComposeInput): Composition {
  const resolved = input.candidates.filter(
    (candidate): candidate is GroundedCandidate & { symbol: NonNullable<GroundedCandidate["symbol"]>; quote: NonNullable<GroundedCandidate["quote"]> } =>
      candidate.status === "resolved" && candidate.symbol != null && candidate.quote != null,
  );
  const dropped: DroppedCandidate[] = input.candidates
    .filter((candidate) => candidate.status !== "resolved")
    .map((candidate) => ({
      ticker: candidate.queryTicker,
      companyName: candidate.companyName,
      status: candidate.status as DroppedCandidate["status"],
      detail: candidate.detail ?? "Not resolved",
    }));

  const overlap = adjustForOverlap({
    budget: input.budget,
    currency: input.currency,
    mode: input.overlapMode,
    candidates: resolved.map((candidate) => ({
      symbol: candidate.symbol.symbol,
      rawSymbol: candidate.symbol.rawSymbol,
      shareClassFigi: candidate.symbol.shareClassFigi,
      weight: candidate.weight,
    })),
    holdings: input.portfolio.holdings,
  });

  const prices = resolved.map((candidate) => {
    const price = executionPrice(candidate.quote, "buy", { marketOpen: input.marketOpen });
    if (price == null) throw new RangeError(`no buy price for ${candidate.symbol.symbol}`);
    return price;
  });

  const allocation = solveWholeShares({
    budget: input.budget,
    lines: resolved.map((candidate, i) => ({
      symbol: candidate.symbol.symbol,
      weight: overlap[i].adjustedWeight,
      price: prices[i],
    })),
    slippageBuffer: DEFAULT_SLIPPAGE_BUFFER,
  });

  const total = input.portfolio.totals.get(input.currency) ?? 0;
  const lines = resolved.map((candidate, i): ComposerLine => {
    const line = overlap[i];
    return {
      symbol: candidate.symbol.symbol,
      companyName: candidate.companyName,
      exchange: candidate.symbol.exchange,
      universalSymbolId: candidate.symbol.id,
      rationale: candidate.rationale,
      holdingNote: candidate.holdingNote,
      price: prices[i],
      priceBasis: priceBasis(candidate.quote, input.marketOpen),
      quote: candidate.quote,
      llmWeight: line.originalWeight,
      targetWeight: line.adjustedWeight,
      units: allocation.lines[i].units,
      overlap: {
        status: line.status,
        heldValue: line.heldValue,
        heldShare: total > 0 && line.heldValue > 0 ? line.heldValue / total : null,
        holdings: line.holdings.map((holding) => ({
          accountName: holding.accountName ?? holding.accountId,
          symbol: holding.symbol,
          marketValue: holding.marketValue,
          currency: holding.currency,
          counted: holding.valueInBudgetCurrency !== null,
        })),
      },
    };
  });

  return { lines, dropped, allocation };
}
