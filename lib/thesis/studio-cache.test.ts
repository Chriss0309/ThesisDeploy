import { beforeEach, describe, expect, it } from "vitest";

import {
  applyStudioWorld,
  basketIdFromPath,
  canExecuteStudioBasket,
  confirmStudioBasket,
  executionHasFill,
  getStudioWorld,
  isMyThesesPath,
  noteBasketFilled,
  noteThesesVisit,
  resetStudioWorld,
  setStudioDialog,
  startStudioBasket,
  type StudioCache,
} from "@/lib/thesis/studio-cache";

beforeEach(() => resetStudioWorld());

function draft(key = "draft-1"): StudioCache {
  return startStudioBasket(getStudioWorld().thesesVisits, key);
}

/** What the Studio button does: confirm only when this basket is still offered. */
function attemptSubmit(cache: StudioCache, basketId: string): { cache: StudioCache; accepted: boolean } {
  if (!canExecuteStudioBasket(cache)) return { cache, accepted: false };
  return { cache: confirmStudioBasket(cache, basketId), accepted: true };
}

describe("studio basket cache", () => {
  it("does not submit the same basket twice after the user opens My Theses", () => {
    let cache = draft();
    const first = attemptSubmit(cache, "basket-1");
    cache = first.cache;
    expect(first.accepted).toBe(true);

    noteThesesVisit();
    cache = applyStudioWorld(cache, true);

    const second = attemptSubmit(cache, "basket-1");
    expect(second.accepted).toBe(false);
    expect(second.cache.draftKey).toBeNull();
    expect(canExecuteStudioBasket(second.cache)).toBe(false);
  });

  it("does not submit the same guest basket twice after demo My Theses", () => {
    let cache = draft();
    cache = attemptSubmit(cache, "guest-basket").cache;

    noteThesesVisit();
    cache = applyStudioWorld(cache, true);

    expect(attemptSubmit(cache, "guest-basket").accepted).toBe(false);
    expect(cache.draftKey).toBeNull();
  });

  it("does not submit the same basket twice after an order fills", () => {
    let cache = setStudioDialog(draft(), true);
    cache = attemptSubmit(cache, "basket-1").cache;
    cache = setStudioDialog(cache, false);

    noteBasketFilled("basket-1");
    cache = applyStudioWorld(cache, true);

    expect(attemptSubmit(cache, "basket-1").accepted).toBe(false);
    expect(cache.draftKey).toBeNull();
    expect(cache.basketId).toBeNull();
  });

  it("keeps the fill on screen until pre-flight closes, then refuses another submit", () => {
    let cache = setStudioDialog(draft(), true);
    cache = attemptSubmit(cache, "basket-1").cache;

    noteBasketFilled("basket-1");
    cache = applyStudioWorld(cache, false);

    expect(cache.draftKey).toBe("draft-1");
    expect(attemptSubmit(cache, "basket-1").accepted).toBe(false);

    cache = setStudioDialog(cache, false);
    expect(cache.draftKey).toBeNull();
    expect(attemptSubmit(cache, "basket-1").accepted).toBe(false);
  });

  it("drops a filled basket that completed while the Studio page was hidden", () => {
    let cache = setStudioDialog(draft(), true);
    cache = attemptSubmit(cache, "guest-basket").cache;
    noteBasketFilled("guest-basket");

    cache = applyStudioWorld(cache, true);

    expect(cache.draftKey).toBeNull();
    expect(attemptSubmit(cache, "guest-basket").accepted).toBe(false);
  });

  it("does not confirm a basket again while its first order is still open", () => {
    const cache = attemptSubmit(draft(), "basket-1").cache;
    expect(cache.draftKey).toBe("draft-1");
    expect(attemptSubmit(cache, "basket-2").accepted).toBe(false);
  });

  it("keeps an unsubmitted basket when the user opens My Theses", () => {
    let cache = draft();
    noteThesesVisit();
    cache = applyStudioWorld(cache, true);

    expect(cache.draftKey).toBe("draft-1");
    expect(attemptSubmit(cache, "basket-1").accepted).toBe(true);
  });

  it("clears a submitted basket from either My Theses page", () => {
    for (const path of ["/theses", "/demo/theses"]) {
      resetStudioWorld();
      let cache = attemptSubmit(draft(), "basket-1").cache;
      expect(isMyThesesPath(path)).toBe(true);
      noteThesesVisit();
      cache = applyStudioWorld(cache, true);
      expect(attemptSubmit(cache, "basket-1").accepted).toBe(false);
      expect(cache.draftKey).toBeNull();
    }
  });

  it("lets a newly generated basket be submitted after the previous one was cleared", () => {
    let cache = attemptSubmit(draft(), "basket-1").cache;
    noteBasketFilled("basket-1");
    cache = applyStudioWorld(cache, true);
    expect(cache.draftKey).toBeNull();

    cache = draft("draft-2");
    cache = attemptSubmit(cache, "basket-2").cache;
    noteBasketFilled("basket-1");
    cache = applyStudioWorld(cache, true);
    expect(cache.draftKey).toBe("draft-2");
    expect(cache.basketId).toBe("basket-2");
  });

  it("does not treat another basket's fill as this one", () => {
    let cache = setStudioDialog(attemptSubmit(draft(), "guest-basket").cache, false);
    noteBasketFilled("someone-else");
    cache = applyStudioWorld(cache, true);
    expect(cache.draftKey).toBe("draft-1");
    expect(cache.submitted).toBe(true);
  });
});

describe("studio cache routes", () => {
  it("maps signed-in and guest My Theses, and ignores the Studio pages", () => {
    expect(isMyThesesPath("/theses")).toBe(true);
    expect(isMyThesesPath("/theses/")).toBe(true);
    expect(isMyThesesPath("/demo/theses")).toBe(true);
    expect(isMyThesesPath("/demo/theses/")).toBe(true);
    expect(isMyThesesPath("/studio")).toBe(false);
    expect(isMyThesesPath("/demo/studio")).toBe(false);
    expect(isMyThesesPath("/baskets/abc")).toBe(false);
    expect(isMyThesesPath("/demo/baskets/abc")).toBe(false);
  });

  it("reads the basket id from signed-in and guest basket paths", () => {
    expect(basketIdFromPath("/baskets/basket-1")).toBe("basket-1");
    expect(basketIdFromPath("/demo/baskets/guest-basket")).toBe("guest-basket");
    expect(basketIdFromPath("/baskets/basket-1?saved=1")).toBe("basket-1");
  });
});

describe("executionHasFill", () => {
  const leg = (status: "executed" | "accepted" | "partial" | "pending" | "rejected", filledUnits: number | null = null) => ({
    status,
    filledUnits,
  });

  it("is true once a leg fills or the run completes", () => {
    expect(executionHasFill({ status: "running", legs: [leg("executed")] })).toBe(true);
    expect(executionHasFill({ status: "working", legs: [leg("partial", 2)] })).toBe(true);
    expect(executionHasFill({ status: "completed", legs: [leg("executed", 4)] })).toBe(true);
    expect(executionHasFill({ status: "partial", legs: [leg("rejected"), leg("executed", 1)] })).toBe(true);
  });

  it("is false when orders are only accepted, pending, or rejected", () => {
    expect(executionHasFill({ status: "running", legs: [leg("accepted"), leg("pending")] })).toBe(false);
    expect(executionHasFill({ status: "failed", legs: [leg("rejected")] })).toBe(false);
    expect(executionHasFill({ status: "working", legs: [leg("accepted", 0)] })).toBe(false);
  });
});
