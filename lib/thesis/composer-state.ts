import {
  EPSILON,
  allocationFromUnits,
  normalizeWeights,
  solveWholeShares,
  type Allocation,
  type SolverInput,
} from "@/lib/solver";

// Basket Composer edits, run in the browser. Active weights always sum to 1
// (or are all 0). Weight changes, removals, and restores re-run the solver;
// the share stepper overrides one line's units and re-prices the basket, but
// never past the solver's spend cap.

export type EditableLine = {
  symbol: string;
  price: number;
  weight: number;
  units: number;
  removed: boolean;
};

export type BasketSettings = { budget: number; slippageBuffer: number };

const active = (lines: readonly EditableLine[]) => lines.filter((line) => !line.removed);

function solverInput(lines: readonly EditableLine[], settings: BasketSettings): SolverInput {
  return {
    budget: settings.budget,
    slippageBuffer: settings.slippageBuffer,
    lines: active(lines).map((line) => ({ symbol: line.symbol, weight: line.weight, price: line.price })),
  };
}

function resolve(lines: EditableLine[], settings: BasketSettings): EditableLine[] {
  const solved = solveWholeShares(solverInput(lines, settings));
  const units = new Map(solved.lines.map((line) => [line.symbol, line.units]));
  return lines.map((line) => (line.removed ? { ...line, units: 0 } : { ...line, units: units.get(line.symbol) ?? 0 }));
}

function renormalize(lines: EditableLine[]): EditableLine[] {
  const live = active(lines);
  const normalized = normalizeWeights(live.map((line) => line.weight));
  const weights = new Map(live.map((line, i) => [line.symbol, normalized[i]]));
  return lines.map((line) => (line.removed ? line : { ...line, weight: weights.get(line.symbol) ?? 0 }));
}

/** Sets one line's weight (0–1) and scales the other active lines to fill the rest. */
export function setWeight(
  lines: readonly EditableLine[],
  symbol: string,
  weight: number,
  settings: BasketSettings,
): EditableLine[] {
  const live = active(lines);
  const others = live.filter((line) => line.symbol !== symbol);
  const target = others.length === 0 ? 1 : Math.min(1, Math.max(0, weight));
  const othersTotal = others.reduce((sum, line) => sum + line.weight, 0);
  const rest = 1 - target;
  const next = lines.map((line) => {
    if (line.removed) return line;
    if (line.symbol === symbol) return { ...line, weight: target };
    return { ...line, weight: othersTotal > 0 ? (line.weight / othersTotal) * rest : rest / others.length };
  });
  return resolve(next, settings);
}

/** Cash left under the spend cap (budget less the slippage reserve) for the current shares. */
export function cashLeft(lines: readonly EditableLine[], settings: BasketSettings): number {
  const allocation = summarize(lines, settings);
  return allocation.spendCap - allocation.invested;
}

/** Whether one more share of an active line fits in the cash left under the spend cap. */
export function canAddShare(lines: readonly EditableLine[], symbol: string, settings: BasketSettings): boolean {
  const line = lines.find((candidate) => candidate.symbol === symbol && !candidate.removed);
  return line != null && line.price <= cashLeft(lines, settings) + EPSILON;
}

/** Adds or removes whole shares on one line; additions that would pass the spend cap are refused. */
export function stepUnits(
  lines: readonly EditableLine[],
  symbol: string,
  delta: number,
  settings: BasketSettings,
): EditableLine[] {
  const line = lines.find((candidate) => candidate.symbol === symbol && !candidate.removed);
  if (!line || (delta > 0 && line.price * delta > cashLeft(lines, settings) + EPSILON)) return [...lines];
  return lines.map((candidate) =>
    candidate === line ? { ...candidate, units: Math.max(0, candidate.units + delta) } : candidate,
  );
}

export function removeLine(lines: readonly EditableLine[], symbol: string, settings: BasketSettings): EditableLine[] {
  const next = lines.map((line) => (line.symbol === symbol ? { ...line, removed: true, units: 0 } : line));
  return resolve(renormalize(next), settings);
}

/** The restored line keeps its last weight, then all active weights are renormalized. */
export function restoreLine(lines: readonly EditableLine[], symbol: string, settings: BasketSettings): EditableLine[] {
  const next = lines.map((line) => (line.symbol === symbol ? { ...line, removed: false } : line));
  return resolve(renormalize(next), settings);
}

/** Cost, leftover cash, and achieved weights for the current share counts. */
export function summarize(lines: readonly EditableLine[], settings: BasketSettings): Allocation {
  return allocationFromUnits(
    solverInput(lines, settings),
    active(lines).map((line) => line.units),
  );
}
