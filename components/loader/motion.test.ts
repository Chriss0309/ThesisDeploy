import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { endlessPlayback, gpuBudget } from "./timing";

const sceneSources = [
  "engine.ts",
  "motifs.ts",
  "timing.ts",
  "loader.tsx",
  "element.ts",
  "../landing/coin-scene.ts",
  "../landing/coin-timeline.ts",
  "../landing/coin-stage.tsx",
];

describe("three.js scenes", () => {
  it("plays through prefers-reduced-motion, looping on desktop and once on phones", () => {
    for (const file of sceneSources) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/prefers-reduced-motion|reducedMotion/);
    }

    const desktop = gpuBudget({ coarsePointer: false, viewportWidth: 768, cores: 8, memoryGb: 16 });
    const coarse = gpuBudget({ coarsePointer: true, viewportWidth: 1440, cores: 8, memoryGb: 16 });
    const narrow = gpuBudget({ coarsePointer: false, viewportWidth: 767, cores: 8, memoryGb: 16 });
    expect(endlessPlayback(Infinity, 8, desktop.constrained)).toBe(Infinity);
    expect(endlessPlayback(Infinity, 8, coarse.constrained)).toBe(8);
    expect(endlessPlayback(Infinity, 8, narrow.constrained)).toBe(8);
    expect(endlessPlayback(1.9, 8, coarse.constrained)).toBe(1.9);
  });

  it("leaves CSS reduced motion in place and documents that the scenes still play", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");

    const doc = readFileSync(new URL("../../docs/design-system.md", import.meta.url), "utf8");
    expect(doc).toContain("collapses CSS animations and transitions only");
    expect(doc).toContain("Desktop windows keep looping");
    expect(doc).not.toContain("draws one still frame per motif");
    expect(doc).not.toContain("Reduced motion gets one still frame");
  });
});
