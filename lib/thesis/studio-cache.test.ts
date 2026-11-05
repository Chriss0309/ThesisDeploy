import { beforeEach, describe, expect, it, vi } from "vitest";

import { removeLine, stepUnits, type EditableLine } from "@/lib/thesis/composer-state";
import {
  STUDIO_SNAPSHOT_KEY,
  STUDIO_SNAPSHOT_TTL_MS,
  applyStudioWorld,
  basketIdFromPath,
  canExecuteStudioBasket,
  confirmStudioBasket,
  dropExpiredStudioSnapshots,
  executionHasFill,
  getStudioWorld,
  isMyThesesPath,
  noteBasketFilled,
  noteThesesVisit,
  readStudioSnapshot,
  resetStudioWorld,
  setStudioDialog,
  startStudioBasket,
  studioSnapshot,
  type StudioCache,
  type StudioScope,
} from "@/lib/thesis/studio-cache";
import type { ComposerLine, ComposerPayload } from "@/types/thesis";

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

describe("studio snapshot", () => {
  const NOW = Date.parse("2026-10-30T12:00:00Z");
  const USER: StudioScope = "live:user-a";
  const settings = { budget: 1000, slippageBuffer: 0 };

  const line = (symbol: string, price: number, targetWeight: number, units: number): ComposerLine => ({
    symbol,
    companyName: `${symbol} Corp`,
    exchange: "TSX",
    universalSymbolId: `usid-${symbol}`,
    rationale: "Fits the thesis.",
    holdingNote: null,
    price,
    priceBasis: "last",
    quote: { last: price, bid: null, ask: null },
    llmWeight: targetWeight,
    targetWeight,
    units,
    overlap: { status: "new", heldValue: 0, heldShare: null, holdings: [] },
  });

  const basket = (ref: string): ComposerPayload => ({
    thesis: {
      id: null,
      ref,
      title: "Canadian Power for AI",
      summary: "Grid and nuclear names.",
      riskProfile: "moderate",
      prompt: "AI power",
      presetKey: null,
      model: "sample",
      latencyMs: null,
      source: "sample",
      generatedAt: "2026-10-30T11:59:00Z",
    },
    account: { id: "acct-tfsa", name: "TFSA", institution: "Questrade", isPaper: false },
    currency: "CAD",
    budget: settings.budget,
    overlapMode: "auto",
    slippageBuffer: settings.slippageBuffer,
    pricing: { source: "demo", market: "TSX", marketOpen: false, asOf: "2026-10-26T20:00:00Z" },
    lines: [line("A", 100, 0.5, 5), line("B", 50, 0.3, 6), line("C", 20, 0.2, 10)],
    dropped: [],
    excluded: [],
    notices: [],
  });

  const generated = (payload: ComposerPayload): EditableLine[] =>
    payload.lines.map((l) => ({ symbol: l.symbol, price: l.price, weight: l.targetWeight, units: l.units, removed: false }));

  const studio = (overrides: Partial<Parameters<typeof studioSnapshot>[0]> = {}) => {
    const payload = basket("ref-1");
    return studioSnapshot({
      scope: USER,
      now: NOW,
      prompt: "AI power",
      presetKey: null,
      form: { accountId: "acct-tfsa", currency: "CAD", budget: 1000, overlapMode: "auto" },
      generating: false,
      cache: startStudioBasket(0, payload.thesis.ref),
      payload,
      arrived: null,
      lines: generated(payload),
      ...overrides,
    });
  };

  const expected: Parameters<typeof readStudioSnapshot>[1] = {
    scope: USER,
    now: NOW + 60_000,
    accountIds: ["acct-tfsa", "acct-rrsp"],
  };
  const read = (raw: string | null, overrides: Partial<typeof expected> = {}) =>
    readStudioSnapshot(raw, { ...expected, ...overrides });

  it("brings back the basket with the edits made in the composer", () => {
    const edited = stepUnits(removeLine(generated(basket("ref-1")), "A", settings), "B", -1, settings);
    const restored = read(JSON.stringify(studio({ lines: edited })));

    expect(restored?.payload?.thesis.ref).toBe("ref-1");
    expect(restored?.lines?.map((l) => [l.symbol, l.units, l.removed])).toEqual([
      ["A", 0, true],
      ["B", 11, false],
      ["C", 20, false],
    ]);
  });

  const saved = JSON.stringify(studio());
  it.each<[string, string | null, Partial<typeof expected>]>([
    ["another user", saved, { scope: "live:user-b" }],
    ["the demo", saved, { scope: "demo" }],
    ["a snapshot older than a day", saved, { now: NOW + STUDIO_SNAPSHOT_TTL_MS }],
    ["an account that isn't connected anymore", saved, { accountIds: ["acct-rrsp"] }],
    ["bad JSON", saved.slice(0, 40), {}],
    ["another version", JSON.stringify({ ...JSON.parse(saved), v: 2 }), {}],
    ["edits that don't match the basket", JSON.stringify({ ...JSON.parse(saved), lines: generated(basket("x")).slice(1) }), {}],
    ["nothing saved", null, {}],
  ])("reads nothing back from %s", (_, raw, overrides) => {
    expect(read(raw, overrides)).toBeNull();
  });

  it("never saves a basket once it was confirmed", () => {
    const confirmed = confirmStudioBasket(startStudioBasket(0, "ref-1"), "basket-1");
    expect(studio({ cache: confirmed })).toBeNull();
    expect(studio({ cache: confirmed, generating: true })?.payload).toBeNull();
  });

  it("keeps a signed-in basket while pre-flight is open, but not a guest one", () => {
    const open = setStudioDialog(startStudioBasket(0, "ref-1"), true);
    expect(studio({ cache: open })?.payload?.thesis.ref).toBe("ref-1");
    expect(studio({ cache: open, scope: "demo" })).toBeNull();
  });

  it("saves the prompt, settings, and previous basket when the page goes away mid-generation", () => {
    const snapshot = studio({ generating: true, prompt: "Critical minerals" });
    expect(snapshot).toMatchObject({ interrupted: true, prompt: "Critical minerals", form: { accountId: "acct-tfsa" } });
    expect(snapshot?.payload?.thesis.ref).toBe("ref-1");
    expect(studio({ generating: true, payload: null, lines: null })).toMatchObject({ interrupted: true, payload: null });
  });

  it("saves a basket that arrived while the loader settles, with its own lines", () => {
    const snapshot = studio({ generating: true, arrived: basket("ref-2") });
    expect(snapshot).toMatchObject({ interrupted: false, lines: null });
    expect(snapshot?.payload?.thesis.ref).toBe("ref-2");
  });

  it("saves nothing without a basket or a generation", () => {
    expect(studio({ payload: null, lines: null })).toBeNull();
  });

  it("drops snapshots older than a day from storage and keeps fresh ones", () => {
    const store = new Map<string, string>([
      [STUDIO_SNAPSHOT_KEY.live, JSON.stringify({ savedAt: NOW - STUDIO_SNAPSHOT_TTL_MS })],
      [STUDIO_SNAPSHOT_KEY.demo, JSON.stringify({ savedAt: NOW - 60_000 })],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
    });
    try {
      dropExpiredStudioSnapshots(NOW);
      expect([...store.keys()]).toEqual([STUDIO_SNAPSHOT_KEY.demo]);
      store.set(STUDIO_SNAPSHOT_KEY.live, "{not json");
      dropExpiredStudioSnapshots(NOW);
      expect(store.has(STUDIO_SNAPSHOT_KEY.live)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
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
