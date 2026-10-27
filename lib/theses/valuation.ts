import { computeDrift, DEFAULT_DRIFT_THRESHOLD, type BasketPosition } from "@/lib/drift";
import type { Marks, PriceMark, ThesisLine, ThesisValuation } from "@/lib/theses/types";

export type HeldConstituent = {
  symbol: string;
  companyName: string;
  targetWeight: number;
  ledgerUnits: number;
  costTotal: number;
  realizedTotal: number;
};

const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Paper marks at the last trade, then the bid/ask midpoint, then whichever side exists. */
export function markPrice(mark: PriceMark | undefined): number | null {
  if (!mark) return null;
  if (positive(mark.last)) return mark.last;
  if (positive(mark.bid) && positive(mark.ask)) return (mark.bid + mark.ask) / 2;
  return positive(mark.bid) ? mark.bid : positive(mark.ask) ? mark.ask : null;
}

export function positionsFrom(
  constituents: readonly HeldConstituent[],
  prices: ReadonlyMap<string, PriceMark>,
): BasketPosition[] | null {
  const positions: BasketPosition[] = [];
  for (const row of constituents) {
    const mark = prices.get(row.symbol);
    const price = markPrice(mark);
    if (price == null) return null;
    positions.push({
      symbol: row.symbol,
      targetWeight: row.targetWeight,
      ledgerUnits: row.ledgerUnits,
      price,
      bid: mark?.bid ?? null,
      ask: mark?.ask ?? null,
    });
  }
  return positions;
}

export type ValuationInput = {
  constituents: readonly HeldConstituent[];
  marks: Marks | null;
  cash: number;
  contributed: number;
  threshold?: number;
};

const pct = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/**
 * Values the basket from its ledger at the cached marks. Returns null while
 * any name has no price, because a partial total would misstate drift. A
 * basket that holds nothing needs no prices.
 */
export function valueBasket({
  constituents,
  marks,
  cash,
  contributed,
  threshold = DEFAULT_DRIFT_THRESHOLD,
}: ValuationInput): ThesisValuation | null {
  const prices = new Map(Object.entries(marks?.prices ?? {}));
  const held = constituents.some((row) => row.ledgerUnits > 0);
  const realized = constituents.reduce((sum, row) => sum + row.realizedTotal, 0);
  const costBasis = constituents.reduce((sum, row) => sum + row.costTotal, 0);

  let lines: ThesisLine[];
  let holdingsValue = 0;
  let maxAbsDrift = 0;
  let rebalanceRecommended = false;

  if (!held) {
    lines = constituents.map((row) => ({
      symbol: row.symbol,
      companyName: row.companyName,
      targetWeight: row.targetWeight,
      units: 0,
      price: markPrice(prices.get(row.symbol)),
      value: 0,
      costBasis: 0,
      unrealized: 0,
      currentWeight: 0,
      drift: 0,
    }));
  } else {
    const positions = positionsFrom(constituents, prices);
    if (!positions) return null;
    const report = computeDrift(positions, { threshold });
    holdingsValue = report.totalValue;
    maxAbsDrift = report.maxAbsDrift;
    rebalanceRecommended = report.rebalanceRecommended;
    lines = report.lines.map((line, i) => ({
      symbol: line.symbol,
      companyName: constituents[i].companyName,
      targetWeight: line.targetWeight,
      units: line.units,
      price: positions[i].price,
      value: line.value,
      costBasis: constituents[i].costTotal,
      unrealized: line.value - constituents[i].costTotal,
      currentWeight: line.currentWeight,
      drift: line.drift,
    }));
  }

  const totalValue = holdingsValue + cash;
  const unrealized = holdingsValue - costBasis;
  return {
    holdingsValue,
    costBasis,
    unrealized,
    realized,
    cash,
    totalValue,
    contributed,
    totalReturn: totalValue - contributed,
    totalReturnPct: pct(totalValue - contributed, contributed),
    unrealizedPct: pct(unrealized, costBasis),
    maxAbsDrift,
    threshold,
    rebalanceRecommended,
    lines,
  };
}
