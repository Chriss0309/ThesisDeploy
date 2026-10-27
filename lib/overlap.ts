import { assertAmount, EPSILON, normalizeWeights } from "@/lib/solver";

/**
 * Top-up overlap rule. In "auto" mode each candidate buys only the gap
 * between its target dollars and what the user already holds:
 * g_i = max(0, w_i × B − H_i), then weights are renormalized to Σ g. If
 * every gap is zero (budget 0, or every name already held at target), all
 * adjusted weights are 0 and nothing is bought. "ignore" mode keeps the
 * weights and only reports the overlap.
 *
 * H_i sums holdings across accounts converted to the budget currency. A
 * holding in a currency with no FX rate is listed but not counted.
 */

export type OverlapMode = "auto" | "ignore";

export type InstrumentIdentity = {
  symbol: string;
  /** Ticker without the exchange suffix ("CCJ" for "CCJ.TO"); derived from `symbol` if absent. */
  rawSymbol?: string | null;
  /** Share-class FIGI, shared by a company's US and Canadian listings. */
  shareClassFigi?: string | null;
};

export type OverlapCandidate = InstrumentIdentity & { weight: number };

export type Holding = InstrumentIdentity & {
  accountId: string;
  accountName?: string;
  /** Market value in the holding's own currency. */
  marketValue: number;
  currency: string;
};

export type OverlapInput = {
  budget: number;
  currency: string;
  mode: OverlapMode;
  candidates: readonly OverlapCandidate[];
  holdings: readonly Holding[];
  /** Budget-currency units per one unit of another currency, e.g. { USD: 1.38 } for a CAD budget. */
  fxRates?: Readonly<Record<string, number>>;
};

export type OverlapStatus = "new" | "adjusted" | "fully_held" | "ignored" | "unconverted";

export type MatchedHolding = Holding & { valueInBudgetCurrency: number | null };

export type OverlapLine = {
  symbol: string;
  originalWeight: number;
  adjustedWeight: number;
  /** Converted holdings only, in the budget currency. */
  heldValue: number;
  status: OverlapStatus;
  holdings: MatchedHolding[];
};

const CANADIAN_SUFFIX = /\.(TO|V|CN|NE)$/;

function rawTicker(instrument: InstrumentIdentity) {
  return (instrument.rawSymbol ?? instrument.symbol).toUpperCase().replace(CANADIAN_SUFFIX, "");
}

/**
 * Share-class FIGI decides when both sides have one, so AT&T (T) and TELUS
 * (T.TO) stay distinct. Without it, raw tickers are compared, which can
 * conflate same-ticker companies on different exchanges.
 */
export function sameCompany(a: InstrumentIdentity, b: InstrumentIdentity) {
  if (a.shareClassFigi && b.shareClassFigi) return a.shareClassFigi === b.shareClassFigi;
  return rawTicker(a) === rawTicker(b);
}

export function adjustForOverlap(input: OverlapInput): OverlapLine[] {
  const { budget, mode, candidates } = input;
  const budgetCurrency = input.currency.toUpperCase();
  assertAmount("budget", budget);
  candidates.forEach((c) => assertAmount(`weight of ${c.symbol}`, c.weight));

  const toBudgetCurrency = (holding: Holding) => {
    if (!Number.isFinite(holding.marketValue)) {
      throw new RangeError(`market value of ${holding.symbol} must be finite`);
    }
    const currency = holding.currency.toUpperCase();
    if (currency === budgetCurrency) return holding.marketValue;
    const rate = input.fxRates?.[currency];
    if (rate === undefined) return null;
    assertAmount(`FX rate for ${currency}`, rate, { positive: true });
    return holding.marketValue * rate;
  };

  const original = normalizeWeights(candidates.map((c) => c.weight));
  const matched = candidates.map((candidate) => {
    const holdings = input.holdings
      .filter((holding) => sameCompany(candidate, holding))
      .map((holding) => ({ ...holding, valueInBudgetCurrency: toBudgetCurrency(holding) }));
    const converted = holdings.filter((h) => h.valueInBudgetCurrency !== null);
    // Net across accounts, so a short elsewhere can't push the target above w × B.
    const heldValue = Math.max(
      0,
      converted.reduce((sum, h) => sum + (h.valueInBudgetCurrency ?? 0), 0),
    );
    return { candidate, holdings, heldValue, anyConverted: converted.length > 0 };
  });

  const gaps = matched.map(({ heldValue }, i) => {
    const gap = original[i] * budget - heldValue;
    return gap > EPSILON ? gap : 0;
  });
  const adjusted = mode === "ignore" ? original : normalizeWeights(gaps);

  return matched.map(({ candidate, holdings, heldValue, anyConverted }, i) => {
    let status: OverlapStatus;
    if (holdings.length === 0) status = "new";
    else if (mode === "ignore") status = "ignored";
    else if (!anyConverted) status = "unconverted";
    else status = heldValue > 0 && gaps[i] === 0 ? "fully_held" : "adjusted";
    return {
      symbol: candidate.symbol,
      originalWeight: original[i],
      adjustedWeight: adjusted[i],
      heldValue,
      status,
      holdings,
    };
  });
}
