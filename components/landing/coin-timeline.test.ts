import { describe, expect, it } from "vitest";

import {
  CYCLE_SECONDS,
  LEGS,
  PACE_SECONDS,
  SETTLED_SECONDS,
  TOTAL_SHARES,
  basketOpacity,
  legStart,
  sharesPlaced,
  stepAt,
} from "./coin-timeline";

describe("coin animation timeline", () => {
  it("starts with pre-flight, then submits one leg per pacing interval", () => {
    expect(stepAt(0)).toEqual({ phase: "preflight" });
    LEGS.forEach((_, index) => {
      expect(stepAt(legStart(index) + 0.01)).toEqual({ phase: "leg", leg: index });
      expect(legStart(index + 1) - legStart(index)).toBeCloseTo(PACE_SECONDS);
    });
    expect(stepAt(legStart(LEGS.length))).toEqual({ phase: "done" });
  });

  it("counts shares placed so far and repeats every cycle", () => {
    expect(sharesPlaced(stepAt(legStart(1) + 0.5))).toBe(LEGS[0].shares + LEGS[1].shares);
    expect(sharesPlaced(stepAt(SETTLED_SECONDS))).toBe(TOTAL_SHARES);
    expect(stepAt(CYCLE_SECONDS + 0.1)).toEqual({ phase: "preflight" });
  });

  it("fades the basket out only at the end of a cycle", () => {
    expect(basketOpacity(SETTLED_SECONDS)).toBe(1);
    expect(basketOpacity(CYCLE_SECONDS - 0.001)).toBeLessThan(0.01);
  });
});
