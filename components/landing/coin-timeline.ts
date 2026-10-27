// Illustrative basket for the landing animation: one order leg per second,
// the pacing ThesisDeploy uses per account. Fictional, not a recommendation.
export const LEGS = [
  { ticker: "VST", shares: 4 },
  { ticker: "ETN", shares: 6 },
  { ticker: "CCJ", shares: 12 },
  { ticker: "CEG", shares: 5 },
] as const;

export const PACE_SECONDS = 1;
const PREFLIGHT_SECONDS = 1.2;
const HOLD_SECONDS = 3;
const FADE_SECONDS = 0.8;

export const TOTAL_SHARES = LEGS.reduce((sum, leg) => sum + leg.shares, 0);
export const CYCLE_SECONDS = PREFLIGHT_SECONDS + LEGS.length * PACE_SECONDS + HOLD_SECONDS + FADE_SECONDS;
/** A moment where every leg has landed; used as the still frame for reduced motion. */
export const SETTLED_SECONDS = PREFLIGHT_SECONDS + LEGS.length * PACE_SECONDS + HOLD_SECONDS / 2;

export type Step = { phase: "preflight" } | { phase: "leg"; leg: number } | { phase: "done" };

export const legStart = (index: number) => PREFLIGHT_SECONDS + index * PACE_SECONDS;

export function stepAt(elapsed: number): Step {
  const t = elapsed % CYCLE_SECONDS;
  if (t < PREFLIGHT_SECONDS) return { phase: "preflight" };
  const leg = Math.floor((t - PREFLIGHT_SECONDS) / PACE_SECONDS);
  return leg < LEGS.length ? { phase: "leg", leg } : { phase: "done" };
}

export function sharesPlaced(step: Step): number {
  if (step.phase === "preflight") return 0;
  if (step.phase === "done") return TOTAL_SHARES;
  return LEGS.slice(0, step.leg + 1).reduce((sum, leg) => sum + leg.shares, 0);
}

/** 1 while the basket is on screen, easing to 0 over the last FADE_SECONDS of a cycle. */
export function basketOpacity(elapsed: number): number {
  const t = elapsed % CYCLE_SECONDS;
  const fadeFrom = CYCLE_SECONDS - FADE_SECONDS;
  return t < fadeFrom ? 1 : 1 - (t - fadeFrom) / FADE_SECONDS;
}
