import { describe, expect, it } from "vitest";

import {
  removeLine,
  restoreLine,
  setWeight,
  stepUnits,
  summarize,
  type EditableLine,
} from "@/lib/thesis/composer-state";

const settings = { budget: 1000, slippageBuffer: 0 };

const lines = (): EditableLine[] => [
  { symbol: "A", price: 100, weight: 0.5, units: 5, removed: false },
  { symbol: "B", price: 50, weight: 0.3, units: 6, removed: false },
  { symbol: "C", price: 20, weight: 0.2, units: 10, removed: false },
];

const weights = (result: EditableLine[]) => result.map((line) => Number(line.weight.toFixed(4)));
const units = (result: EditableLine[]) => result.map((line) => line.units);

describe("Basket Composer edits", () => {
  it("sets one weight, scales the others proportionally, and re-solves", () => {
    const result = setWeight(lines(), "A", 0.2, settings);
    // B and C keep their 3:2 ratio within the remaining 80%.
    expect(weights(result)).toEqual([0.2, 0.48, 0.32]);
    expect(units(result)).toEqual([2, 9, 16]);
    expect(summarize(result, settings).invested).toBe(970);
  });

  it("splits the rest evenly when every other weight is zero", () => {
    const zeroed = lines().map((line) => ({ ...line, weight: line.symbol === "A" ? 1 : 0 }));
    expect(weights(setWeight(zeroed, "A", 0.4, settings))).toEqual([0.4, 0.3, 0.3]);
  });

  it("keeps a lone line at 100%", () => {
    const one = removeLine(removeLine(lines(), "B", settings), "C", settings);
    expect(setWeight(one, "A", 0.3, settings).find((line) => line.symbol === "A")?.weight).toBe(1);
  });

  it("steps one line's shares without touching weights, and never below zero", () => {
    const stepped = stepUnits(lines(), "B", 2);
    expect(units(stepped)).toEqual([5, 8, 10]);
    expect(weights(stepped)).toEqual(weights(lines()));
    expect(units(stepUnits(lines(), "A", -9))[0]).toBe(0);
    const summary = summarize(stepped, settings);
    expect(summary.invested).toBe(1100);
    expect(summary.overSpendCap).toBe(true);
    expect(summary.unallocated).toBe(-100);
  });

  it("removes a line, renormalizes the rest, and restores it", () => {
    const removed = removeLine(lines(), "A", settings);
    expect(removed[0]).toMatchObject({ removed: true, units: 0 });
    expect(weights(removed).slice(1)).toEqual([0.6, 0.4]);
    expect(summarize(removed, settings).lines.map((line) => line.symbol)).toEqual(["B", "C"]);

    const restored = restoreLine(removed, "A", settings);
    expect(restored[0].removed).toBe(false);
    expect(restored.reduce((sum, line) => sum + line.weight, 0)).toBeCloseTo(1);
    expect(summarize(restored, settings).invested).toBeLessThanOrEqual(1000);
  });
});
