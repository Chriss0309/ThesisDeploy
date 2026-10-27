import {
  assertAmount,
  DEFAULT_SLIPPAGE_BUFFER,
  EPSILON,
  executionPrice,
  normalizeWeights,
  solveWholeShares,
} from "@/lib/solver";

/**
 * Drift, rebalance, and close for a virtual basket. Everything is valued in
 * the basket currency from the basket ledger. In Live mode the account's
 * actual units cap the ledger, because the user can sell the same stock
 * outside the app: the basket is valued, rebalanced, and closed from
 * min(ledger, actual) and flagged when the ledger is higher.
 */

/** Absolute drift, in weight units (0.05 = 5 percentage points). */
export const DEFAULT_DRIFT_THRESHOLD = 0.05;

export type BasketPosition = {
  symbol: string;
  targetWeight: number;
  /** Units the basket owns, from fills only. */
  ledgerUnits: number;
  /** Units actually in the account (Live only). */
  actualUnits?: number;
  /** Mark price: the positions snapshot (Live) or the last trade (Paper). */
  price: number;
  bid?: number | null;
  ask?: number | null;
};

export type DriftLine = {
  symbol: string;
  targetWeight: number;
  units: number;
  value: number;
  currentWeight: number;
  drift: number;
  ledgerExceedsHoldings: boolean;
};

export type DriftReport = {
  lines: DriftLine[];
  totalValue: number;
  maxAbsDrift: number;
  rebalanceRecommended: boolean;
};

export type TradeLeg = {
  action: "SELL" | "BUY";
  symbol: string;
  units: number;
  estPrice: number;
  estValue: number;
};

export type RebalancePlan = {
  /** SELL legs first, then BUY legs. */
  legs: TradeLeg[];
  sellProceeds: number;
  buyCost: number;
};

type PricingOptions = { marketOpen?: boolean };

/** An empty basket (no units left) reports zero drift and no recommendation. */
export function computeDrift(
  positions: readonly BasketPosition[],
  { threshold = DEFAULT_DRIFT_THRESHOLD }: { threshold?: number } = {},
): DriftReport {
  assertAmount("threshold", threshold);
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p.symbol)) throw new RangeError(`duplicate symbol ${p.symbol}`);
    seen.add(p.symbol);
    assertAmount(`ledger units of ${p.symbol}`, p.ledgerUnits);
    if (p.actualUnits !== undefined) assertAmount(`actual units of ${p.symbol}`, p.actualUnits);
    assertAmount(`price of ${p.symbol}`, p.price, { positive: true });
    assertAmount(`target weight of ${p.symbol}`, p.targetWeight);
  }

  const targets = normalizeWeights(positions.map((p) => p.targetWeight));
  const units = positions.map((p) => Math.min(p.ledgerUnits, p.actualUnits ?? Infinity));
  const values = positions.map((p, i) => units[i] * p.price);
  const totalValue = values.reduce((sum, v) => sum + v, 0);

  const lines = positions.map((p, i) => {
    const currentWeight = totalValue > 0 ? values[i] / totalValue : 0;
    return {
      symbol: p.symbol,
      targetWeight: targets[i],
      units: units[i],
      value: values[i],
      currentWeight,
      drift: totalValue > 0 ? currentWeight - targets[i] : 0,
      ledgerExceedsHoldings: units[i] < p.ledgerUnits,
    };
  });
  const maxAbsDrift = lines.reduce((max, line) => Math.max(max, Math.abs(line.drift)), 0);

  return {
    lines,
    totalValue,
    maxAbsDrift,
    rebalanceRecommended: maxAbsDrift > threshold + EPSILON,
  };
}

/**
 * Cash-neutral rebalance. With T_i = w_i × V, overweight names sell
 * floor((V_i − T_i) / p_i) shares. The estimated proceeds (at the bid) then
 * fund the solver, weighted by each name's gap max(0, T_i − V_i) and priced
 * at the ask; the solver applies the slippage buffer. Whole-share rounding
 * can leave a drifted basket with no legs.
 */
export function planRebalance(
  positions: readonly BasketPosition[],
  { slippageBuffer = DEFAULT_SLIPPAGE_BUFFER, marketOpen = true }: PricingOptions & {
    slippageBuffer?: number;
  } = {},
): RebalancePlan {
  const { lines, totalValue } = computeDrift(positions);

  const sells: TradeLeg[] = [];
  lines.forEach((line, i) => {
    const excess = line.value - line.targetWeight * totalValue;
    if (excess <= EPSILON) return;
    const units = Math.floor(excess / positions[i].price + EPSILON);
    if (units > 0) sells.push(leg("SELL", positions[i], units, marketOpen));
  });
  const sellProceeds = sells.reduce((sum, l) => sum + l.estValue, 0);

  const allocation = solveWholeShares({
    budget: sellProceeds,
    slippageBuffer,
    lines: lines.map((line, i) => ({
      symbol: line.symbol,
      weight: Math.max(0, line.targetWeight * totalValue - line.value),
      price: priceFor(positions[i], "buy", marketOpen),
    })),
  });
  const buys = allocation.lines
    .map((line, i) => (line.units > 0 ? leg("BUY", positions[i], line.units, marketOpen) : null))
    .filter((l): l is TradeLeg => l !== null);

  return {
    legs: [...sells, ...buys],
    sellProceeds,
    buyCost: buys.reduce((sum, l) => sum + l.estValue, 0),
  };
}

/** Sells every whole share the basket still owns: floor(min(ledger, actual)). */
export function planClose(
  positions: readonly BasketPosition[],
  { marketOpen = true }: PricingOptions = {},
): TradeLeg[] {
  const { lines } = computeDrift(positions);
  return lines
    .map((line, i) => {
      const units = Math.floor(line.units + EPSILON);
      return units > 0 ? leg("SELL", positions[i], units, marketOpen) : null;
    })
    .filter((l): l is TradeLeg => l !== null);
}

function priceFor(position: BasketPosition, side: "buy" | "sell", marketOpen: boolean) {
  const { price, bid, ask } = position;
  return executionPrice({ last: price, bid, ask }, side, { marketOpen }) ?? price;
}

function leg(
  action: TradeLeg["action"],
  position: BasketPosition,
  units: number,
  marketOpen: boolean,
): TradeLeg {
  const estPrice = priceFor(position, action === "SELL" ? "sell" : "buy", marketOpen);
  return { action, symbol: position.symbol, units, estPrice, estValue: units * estPrice };
}
