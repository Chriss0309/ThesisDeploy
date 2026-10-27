import { describe, expect, it } from "vitest";

import {
  LOADER_VARIANTS,
  MARKS,
  animatedViews,
  appearDelay,
  backingSize,
  gpuBudget,
  parseLegs,
  parseMs,
  settleHold,
  stackHeights,
} from "./timing";

describe("loader timing", () => {
  it("parses timing tokens", () => {
    expect(parseMs("300ms", 1)).toBe(300);
    expect(parseMs(" 0.45s", 1)).toBe(450);
    expect(parseMs("", 7)).toBe(7);
    expect(parseMs("fast", 7)).toBe(7);
  });

  it("waits before appearing, except when taking over from a loader that just left", () => {
    expect(appearDelay({ delayMs: 300, now: 1000 })).toBe(300);
    expect(appearDelay({ delayMs: 300, now: 1000, lastVisibleAt: 900 })).toBe(0);
    expect(appearDelay({ delayMs: 300, now: 1000, lastVisibleAt: 100 })).toBe(300);
    expect(appearDelay({ delayMs: 300, now: 1000, sincePageStart: 1200 })).toBe(0);
  });

  it("never flashes: a loader that appeared stays up for the minimum, one that didn't reveals at once", () => {
    const timing = { minVisibleMs: 600, settleMs: 450 };
    expect(settleHold({ shownAt: null, finishedAt: 500, ...timing })).toBe(0);
    expect(settleHold({ shownAt: 1000, finishedAt: 1050, ...timing })).toBe(550);
    expect(settleHold({ shownAt: 1000, finishedAt: 9000, ...timing })).toBe(450);
  });
});

describe("GPU budget", () => {
  it("throttles phones and low-end machines", () => {
    expect(gpuBudget({ coarsePointer: true, viewportWidth: 390 }).fps).toBe(30);
    expect(gpuBudget({ coarsePointer: false, viewportWidth: 1440, cores: 8, memoryGb: 16 }).fps).toBe(60);
    expect(gpuBudget({ coarsePointer: false, viewportWidth: 1440, cores: 4 }).fps).toBe(30);
    expect(gpuBudget({ coarsePointer: true, viewportWidth: 390 }).constrained).toBe(true);
    expect(gpuBudget({ coarsePointer: false, viewportWidth: 1440, cores: 8, memoryGb: 16 }).constrained).toBe(false);
  });

  it("animates the largest loaders that fit the frame budget and freezes the rest", () => {
    expect([...animatedViews([100, 500, 300], 800)].sort()).toEqual([1, 2]);
    expect([...animatedViews([2000], 800)]).toEqual([0]);
    expect(animatedViews([], 800).size).toBe(0);
  });

  it("caps the backing store by pixel ratio and pixel count", () => {
    const phone = gpuBudget({ coarsePointer: true, viewportWidth: 390 });
    expect(backingSize(100, 50, 3, phone)).toEqual({ width: 150, height: 75 });
    const big = backingSize(1000, 1000, 3, phone);
    expect(big.width * big.height).toBeLessThanOrEqual(phone.maxPixels + 2000);
  });
});

describe("execution stacks", () => {
  it("draws coins in proportion to shares, within readable bounds", () => {
    expect(stackHeights([{ shares: 4 }, { shares: 12 }, { shares: 1 }])).toEqual([3, 10, 2]);
  });

  it("reads a basket's legs from a mark attribute, ignoring junk", () => {
    expect(parseLegs("18,2,0,3")?.legs.map((leg) => [leg.shares, leg.status])).toEqual([
      [18, "submitted"],
      [2, "submitted"],
      [3, "submitted"],
    ]);
    expect(parseLegs("")).toBeUndefined();
    expect(parseLegs(null)).toBeUndefined();
    expect(parseLegs("a,-1")).toBeUndefined();
  });

  it("maps every mark to a motif in the family and a one-shot or waiting pose", () => {
    for (const { variant, pose } of Object.values(MARKS)) {
      expect(LOADER_VARIANTS).toContain(variant);
      expect(pose).not.toBe("loading");
    }
  });
});
