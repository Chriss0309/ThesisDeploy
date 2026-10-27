// Pure rules shared by every loader; the three.js engine and React wrappers import these.

export const LOADER_VARIANTS = ["coin", "link", "scan", "orbit", "stacks"] as const;
export type LoaderVariant = (typeof LOADER_VARIANTS)[number];

export type LegStatus = "queued" | "pacing" | "submitting" | "submitted" | "failed";
export type ExecutionLeg = { symbol: string; shares: number; status: LegStatus };
/** Live state for the `stacks` variant; omit it for an indeterminate loop. */
export type ExecutionProgress = { legs: ExecutionLeg[] };

/**
 * What a motif is doing. `loading` loops (the loaders); every other pose plays once
 * when its content renders and then holds a still frame.
 */
export type Pose = "loading" | "reveal" | "success" | "lost" | "linked" | "apart" | "broken" | "empty" | "paced" | "drift";

/** Content-time marks: one motif and pose per meaning, so every page reads the same way. */
export const MARKS = {
  xray: { variant: "scan", pose: "reveal" },
  studio: { variant: "orbit", pose: "reveal" },
  theses: { variant: "stacks", pose: "drift" },
  basket: { variant: "stacks", pose: "reveal" },
  signin: { variant: "link", pose: "apart" },
  connected: { variant: "link", pose: "linked" },
  error: { variant: "link", pose: "broken" },
  "rate-limit": { variant: "stacks", pose: "paced" },
  empty: { variant: "stacks", pose: "empty" },
  success: { variant: "coin", pose: "success" },
  lost: { variant: "coin", pose: "lost" },
} as const satisfies Record<string, { variant: LoaderVariant; pose: Pose }>;
export type MarkKind = keyof typeof MARKS;

/** `legs="4,6,12"` (shares per leg) as filled stacks; anything unparseable is ignored. */
export function parseLegs(value: string | null | undefined): ExecutionProgress | undefined {
  const shares = (value ?? "")
    .split(",")
    .map(Number)
    .filter((count) => Number.isFinite(count) && count > 0);
  if (shares.length === 0) return undefined;
  return { legs: shares.map((count, i) => ({ symbol: `L${i}`, shares: count, status: "submitted" })) };
}

/** Fallbacks for the --loader-* timing tokens in app/tokens.css. */
export const DEFAULT_TIMING = { delayMs: 300, minVisibleMs: 600, settleMs: 450 };

export function parseMs(value: string | null | undefined, fallback: number): number {
  const match = value?.trim().match(/^(-?[\d.]+)(ms|s)?$/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? (match[2] === "s" ? amount * 1000 : amount) : fallback;
}

/**
 * How long a loader waits before appearing. A loader of the same variant that was on
 * screen moments ago (a loading.tsx handing over to a Suspense fallback) skips the
 * delay so the motif doesn't blink out and back.
 */
export function appearDelay({
  delayMs,
  now,
  lastVisibleAt,
  sincePageStart,
}: {
  delayMs: number;
  now: number;
  lastVisibleAt?: number;
  /** Milliseconds since navigation start on the initial page load (hydration can be late). */
  sincePageStart?: number;
}): number {
  if (lastVisibleAt != null && now - lastVisibleAt < delayMs) return 0;
  return Math.max(0, delayMs - (sincePageStart ?? 0));
}

/**
 * Time to keep a loader up after its work finished: never shown means reveal now;
 * otherwise play the settle and stay at least minVisibleMs so it never flashes.
 */
export function settleHold({
  shownAt,
  finishedAt,
  minVisibleMs,
  settleMs,
}: {
  shownAt: number | null;
  finishedAt: number;
  minVisibleMs: number;
  settleMs: number;
}): number {
  if (shownAt == null) return 0;
  return Math.max(settleMs, minVisibleMs - (finishedAt - shownAt));
}

export type GpuBudget = {
  fps: number;
  maxDpr: number;
  /** Largest backing store for one loader canvas. */
  maxPixels: number;
  /** Pixels animated per frame across all loaders; the rest hold a still frame. */
  framePixels: number;
};

/** Mobile and low-end devices get fewer frames and pixels per loader and per frame. */
export function gpuBudget({
  coarsePointer,
  viewportWidth,
  cores,
  memoryGb,
}: {
  coarsePointer: boolean;
  viewportWidth: number;
  cores?: number;
  memoryGb?: number;
}): GpuBudget {
  const constrained =
    coarsePointer || viewportWidth < 768 || (cores != null && cores <= 4) || (memoryGb != null && memoryGb <= 4);
  return constrained
    ? { fps: 30, maxDpr: 1.5, maxPixels: 420_000, framePixels: 750_000 }
    : { fps: 60, maxDpr: 2, maxPixels: 1_200_000, framePixels: 3_000_000 };
}

/** Backing-store size for a canvas, capped by the budget's pixel ratio and pixel count. */
export function backingSize(cssWidth: number, cssHeight: number, devicePixelRatio: number, budget: GpuBudget) {
  const ratio = Math.min(devicePixelRatio, budget.maxDpr);
  const scale = Math.min(ratio, Math.sqrt(budget.maxPixels / Math.max(cssWidth * cssHeight, 1)));
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}

/**
 * Which loaders animate this frame: largest first (the showpiece over inline glyphs),
 * while the frame's pixel budget lasts. Returns indexes into `areas`.
 */
export function animatedViews(areas: number[], framePixels: number): Set<number> {
  const order = areas.map((area, index) => ({ area, index })).sort((a, b) => b.area - a.area);
  const chosen = new Set<number>();
  let used = 0;
  for (const { area, index } of order) {
    if (chosen.size > 0 && used + area > framePixels) continue;
    chosen.add(index);
    used += area;
  }
  return chosen;
}

/** Coins drawn per leg: proportional to shares, readable at any basket size. */
export function stackHeights(legs: Pick<ExecutionLeg, "shares">[], maxCoins = 10): number[] {
  const most = Math.max(1, ...legs.map((leg) => leg.shares));
  return legs.map((leg) => Math.max(2, Math.min(maxCoins, Math.round((leg.shares / most) * maxCoins))));
}
