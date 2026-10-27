import { describe, expect, it } from "vitest";

import {
  canAddShare,
  cashLeft,
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

  it("steps one line's shares down without touching weights, and never below zero", () => {
    const stepped = stepUnits(lines(), "A", -1, settings);
    expect(units(stepped)).toEqual([4, 6, 10]);
    expect(weights(stepped)).toEqual(weights(lines()));
    expect(units(stepUnits(lines(), "A", -9, settings))[0]).toBe(0);
  });

  it("refuses a share that would pass the spend cap", () => {
    // Fully invested: 5 × 100 + 6 × 50 + 10 × 20 = 1,000 of a 1,000 cap.
    expect(cashLeft(lines(), settings)).toBe(0);
    expect(canAddShare(lines(), "C", settings)).toBe(false);
    const refused = stepUnits(lines(), "C", 1, settings);
    expect(units(refused)).toEqual([5, 6, 10]);
    expect(summarize(refused, settings).overSpendCap).toBe(false);
  });

  it("adds shares only while they fit in the cash left under the spend cap", () => {
    let current = stepUnits(lines(), "A", -1, settings);
    expect(cashLeft(current, settings)).toBe(100);
    expect(["A", "B", "C"].map((symbol) => canAddShare(current, symbol, settings))).toEqual([true, true, true]);

    current = stepUnits(current, "B", 1, settings);
    current = stepUnits(current, "B", 1, settings);
    expect(units(current)).toEqual([4, 8, 10]);
    expect(canAddShare(current, "B", settings)).toBe(false);
    expect(units(stepUnits(current, "B", 1, settings))).toEqual([4, 8, 10]);

    const freed = stepUnits(lines(), "A", -1, settings);
    expect(units(stepUnits(freed, "C", 6, settings))).toEqual([4, 6, 10]);
    expect(units(stepUnits(freed, "C", 5, settings))).toEqual([4, 6, 15]);
  });

  it("measures the cash left against the slippage-reduced spend cap, not the raw budget", () => {
    const one: EditableLine[] = [{ symbol: "A", price: 100, weight: 1, units: 9, removed: false }];
    const buffered = { budget: 1000, slippageBuffer: 0.015 };
    // 1,000 budget, 985 spend cap, 900 invested: 100 of budget but only 85 of cap left.
    expect(cashLeft(one, buffered)).toBeCloseTo(85);
    expect(canAddShare(one, "A", buffered)).toBe(false);
    expect(units(stepUnits(one, "A", 1, buffered))).toEqual([9]);
  });

  it("can't add shares to a removed line", () => {
    const removed = removeLine(stepUnits(lines(), "A", -3, settings), "B", settings);
    expect(canAddShare(removed, "B", settings)).toBe(false);
    expect(stepUnits(removed, "B", 1, settings).find((line) => line.symbol === "B")?.units).toBe(0);
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
