import type { AccountSnapshot, Holding } from "@/lib/portfolio/types";

export type ConcentrationSegment = {
  label: string;
  value: number;
  weight: number;
  kind: "holding" | "other" | "cash";
};

export type CurrencyConcentration = {
  currency: string;
  total: number;
  segments: ConcentrationSegment[];
  /** Symbol -> weight within this currency, for every counted holding. */
  weights: Map<string, number>;
};

// Holdings without a currency fall back to the account's only cash currency.
function currencyOf(holding: Holding, snapshot: AccountSnapshot): string | null {
  if (holding.currency) return holding.currency;
  return snapshot.balances.length === 1 ? snapshot.balances[0].currency : null;
}

/**
 * One bar per currency, because there is no FX conversion: positions and cash
 * in USD and CAD are never summed together. Cash-equivalent positions are
 * already inside the cash balance, so they are not counted twice. Short
 * positions and negative (margin) cash are left out of the bar.
 */
export function concentrationByCurrency(
  snapshot: AccountSnapshot,
  topN = 5,
): CurrencyConcentration[] {
  const currencies = new Set<string>(snapshot.balances.map((balance) => balance.currency));
  const holdingsByCurrency = new Map<string, Holding[]>();
  for (const holding of snapshot.holdings) {
    const currency = currencyOf(holding, snapshot);
    if (!currency || holding.cashEquivalent || !holding.marketValue || holding.marketValue <= 0) {
      continue;
    }
    currencies.add(currency);
    holdingsByCurrency.set(currency, [...(holdingsByCurrency.get(currency) ?? []), holding]);
  }

  const result: CurrencyConcentration[] = [];
  for (const currency of [...currencies].sort()) {
    const holdings = (holdingsByCurrency.get(currency) ?? []).sort(
      (a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0),
    );
    const cash = Math.max(
      0,
      snapshot.balances.find((balance) => balance.currency === currency)?.cash ?? 0,
    );
    const holdingsTotal = holdings.reduce((sum, holding) => sum + (holding.marketValue ?? 0), 0);
    const total = holdingsTotal + cash;
    if (total <= 0) continue;

    const top = holdings.slice(0, topN);
    const rest = holdings.slice(topN);
    const restValue = rest.reduce((sum, holding) => sum + (holding.marketValue ?? 0), 0);
    const segments: ConcentrationSegment[] = [
      ...top.map((holding) => ({
        label: holding.symbol,
        value: holding.marketValue ?? 0,
        weight: (holding.marketValue ?? 0) / total,
        kind: "holding" as const,
      })),
      ...(rest.length > 0
        ? [{ label: `${rest.length} other`, value: restValue, weight: restValue / total, kind: "other" as const }]
        : []),
      ...(cash > 0 ? [{ label: "Cash", value: cash, weight: cash / total, kind: "cash" as const }] : []),
    ];

    result.push({
      currency,
      total,
      segments,
      weights: new Map(holdings.map((holding) => [holding.symbol, (holding.marketValue ?? 0) / total])),
    });
  }
  return result;
}
