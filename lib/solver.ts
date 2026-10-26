/**
 * Whole-share basket solver. All amounts are in the basket currency; the
 * caller guarantees single-currency inputs (grounding drops other listings).
 *
 * 1. Spend cap: B_eff = min(budget, cash) × (1 − slippage buffer).
 * 2. Floor pass: n_i = floor(B_eff × w_i / P_i).
 * 3. Remainder pass: repeatedly add one share to the affordable line whose
 *    dollar error |w_i B_eff − n_i P_i| drops the most; stop when no share
 *    both fits the remaining cash and reduces error. Ties go to the earlier
 *    line. Cash a name can't use stays unallocated rather than being moved
 *    to other names.
 */

export const DEFAULT_SLIPPAGE_BUFFER = 0.015;

// Absorbs float noise such as 0.55 - 0.5 = 0.05000000000000004; far below a cent.
export const EPSILON = 1e-6;

export type Side = "buy" | "sell";

export type Quote = {
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
};

/**
 * Buys at the ask and sells at the bid, falling back to the last trade.
 * Outside the regular session bid/ask are often stale or zero, so the last
 * trade comes first. Returns null when no positive price exists.
 */
export function executionPrice(
  quote: Quote,
  side: Side,
  { marketOpen = true }: { marketOpen?: boolean } = {},
): number | null {
  const sideQuote = side === "buy" ? quote.ask : quote.bid;
  const order = marketOpen ? [sideQuote, quote.last] : [quote.last, sideQuote];
  for (const price of order) {
    if (typeof price === "number" && Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

export type SolverLine = {
  symbol: string;
  /** Relative weight; lines are normalized to sum to 1. */
  weight: number;
  price: number;
};

export type SolverInput = {
  budget: number;
  lines: readonly SolverLine[];
  /** Cash available for Live orders; omit for Paper. */
  cash?: number;
  slippageBuffer?: number;
};

export type AllocatedLine = {
  symbol: string;
  price: number;
  targetWeight: number;
  units: number;
  cost: number;
  achievedWeight: number;
  /** Has a target weight but holds no shares: the price exceeds its slice. */
  belowOneShare: boolean;
};

export type Allocation = {
  lines: AllocatedLine[];
  budget: number;
  spendCap: number;
  invested: number;
  /** budget − invested, including the slippage reserve. */
  unallocated: number;
  /** ½ Σ |achieved − target|: 0 is a perfect match, 1 means nothing was bought. */
  trackingError: number;
  limitedByCash: boolean;
  /** Only manual unit overrides can exceed the spend cap. */
  overSpendCap: boolean;
};

export function solveWholeShares(input: SolverInput): Allocation {
  const { weights, spendCap } = prepare(input);
  const { lines } = input;
  const units = lines.map((line, i) =>
    Math.floor((weights[i] * spendCap) / line.price + EPSILON),
  );
  let remaining = spendCap - totalCost(lines, units);

  for (;;) {
    let best = -1;
    let bestGain = 0;
    lines.forEach((line, i) => {
      if (line.price > remaining + EPSILON) return;
      const shortfall = weights[i] * spendCap - units[i] * line.price;
      const gain = Math.abs(shortfall) - Math.abs(shortfall - line.price);
      if (gain > EPSILON && (best < 0 || gain > bestGain + EPSILON)) {
        best = i;
        bestGain = gain;
      }
    });
    if (best < 0) break;
    units[best] += 1;
    remaining -= lines[best].price;
  }

  return summarize(input, weights, spendCap, units);
}

/** Re-prices user-chosen share counts (the composer's stepper) against the same caps. */
export function allocationFromUnits(input: SolverInput, units: readonly number[]): Allocation {
  const { weights, spendCap } = prepare(input);
  if (units.length !== input.lines.length) {
    throw new RangeError("units must have one entry per line");
  }
  units.forEach((n, i) => {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`units for ${input.lines[i].symbol} must be a whole number ≥ 0`);
    }
  });
  return summarize(input, weights, spendCap, [...units]);
}

export function normalizeWeights(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  return total > 0 ? weights.map((w) => w / total) : weights.map(() => 0);
}

export function assertAmount(label: string, value: number, { positive = false } = {}) {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new RangeError(`${label} must be a finite number ${positive ? "> 0" : "≥ 0"}`);
  }
}

function prepare(input: SolverInput) {
  const { budget, cash, lines, slippageBuffer = DEFAULT_SLIPPAGE_BUFFER } = input;
  assertAmount("budget", budget);
  if (cash !== undefined) assertAmount("cash", cash);
  if (!(slippageBuffer >= 0 && slippageBuffer < 1)) {
    throw new RangeError("slippageBuffer must be in [0, 1)");
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.symbol)) throw new RangeError(`duplicate symbol ${line.symbol}`);
    seen.add(line.symbol);
    assertAmount(`price of ${line.symbol}`, line.price, { positive: true });
    assertAmount(`weight of ${line.symbol}`, line.weight);
  }
  return {
    weights: normalizeWeights(lines.map((line) => line.weight)),
    spendCap: Math.min(budget, cash ?? Infinity) * (1 - slippageBuffer),
  };
}

function totalCost(lines: readonly SolverLine[], units: readonly number[]) {
  return lines.reduce((sum, line, i) => sum + units[i] * line.price, 0);
}

function summarize(
  input: SolverInput,
  weights: number[],
  spendCap: number,
  units: number[],
): Allocation {
  const invested = totalCost(input.lines, units);
  const lines = input.lines.map((line, i) => {
    const cost = units[i] * line.price;
    return {
      symbol: line.symbol,
      price: line.price,
      targetWeight: weights[i],
      units: units[i],
      cost,
      achievedWeight: invested > 0 ? cost / invested : 0,
      belowOneShare: weights[i] > 0 && units[i] === 0,
    };
  });
  const hasTarget = weights.some((w) => w > 0);
  const trackingError =
    invested > 0
      ? lines.reduce((sum, line) => sum + Math.abs(line.achievedWeight - line.targetWeight), 0) / 2
      : hasTarget
        ? 1
        : 0;

  return {
    lines,
    budget: input.budget,
    spendCap,
    invested,
    unallocated: input.budget - invested,
    trackingError,
    limitedByCash: input.cash !== undefined && input.cash < input.budget,
    overSpendCap: invested > spendCap + EPSILON,
  };
}
