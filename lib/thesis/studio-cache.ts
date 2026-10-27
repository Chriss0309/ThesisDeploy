import type { ExecutionStatus, LegStatus } from "@/lib/execution/types";

/**
 * Thesis Studio keeps the composed basket in client state. Cache Components
 * preserve that state with React Activity, so the page still offers the same
 * basket after a navigation. This is not a server cache or a saved draft.
 *
 * Once the user confirms the orders, drop the basket when they open My Theses
 * (`/theses` or `/demo/theses`) or when one of its orders fills. An unsubmitted
 * draft stays put.
 */

export type StudioCache = {
  draftKey: string | null;
  basketId: string | null;
  submitted: boolean;
  dialogOpen: boolean;
  /** A fill arrived while pre-flight was still open, so the dialog stays up. */
  invalidated: boolean;
  thesesBaseline: number;
};

export type StudioWorld = {
  thesesVisits: number;
  filledBasketIds: ReadonlySet<string>;
};

export function emptyStudioCache(): StudioCache {
  return {
    draftKey: null,
    basketId: null,
    submitted: false,
    dialogOpen: false,
    invalidated: false,
    thesesBaseline: 0,
  };
}

export function emptyStudioWorld(): StudioWorld {
  return { thesesVisits: 0, filledBasketIds: new Set() };
}

/** Signed-in My Theses and the guest demo page. The primary nav always points at `/theses`. */
export function isMyThesesPath(pathname: string): boolean {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return path === "/theses" || path === "/demo/theses";
}

export function basketIdFromPath(path: string): string | null {
  const id = path.split(/[?#]/)[0].split("/").filter(Boolean).pop();
  return id && id !== "baskets" ? id : null;
}

export function startStudioBasket(thesesVisitsAtStart: number, draftKey: string): StudioCache {
  return {
    draftKey,
    basketId: null,
    submitted: false,
    dialogOpen: false,
    invalidated: false,
    thesesBaseline: thesesVisitsAtStart,
  };
}

/** The same composed basket cannot be confirmed again. */
export function canExecuteStudioBasket(cache: StudioCache): boolean {
  return cache.draftKey != null && !cache.submitted && !cache.invalidated;
}

export function confirmStudioBasket(cache: StudioCache, basketId: string): StudioCache {
  if (!canExecuteStudioBasket(cache)) return cache;
  return { ...cache, submitted: true, basketId };
}

export function setStudioDialog(cache: StudioCache, dialogOpen: boolean): StudioCache {
  if (!cache.draftKey || cache.dialogOpen === dialogOpen) return cache;
  if (!dialogOpen && cache.invalidated) return { ...emptyStudioCache(), thesesBaseline: cache.thesesBaseline };
  return { ...cache, dialogOpen };
}

function sameCache(a: StudioCache, b: StudioCache): boolean {
  return (
    a.draftKey === b.draftKey &&
    a.basketId === b.basketId &&
    a.submitted === b.submitted &&
    a.dialogOpen === b.dialogOpen &&
    a.invalidated === b.invalidated &&
    a.thesesBaseline === b.thesesBaseline
  );
}

/**
 * Apply visits and fills recorded while this page was hidden (`restore`) or
 * still on screen. A fill on the open pre-flight dialog leaves the dialog up
 * until it closes; coming back to the page, or opening My Theses, drops the
 * basket immediately.
 */
export function reconcileStudioCache(cache: StudioCache, world: StudioWorld, restore = false): StudioCache {
  if (!cache.draftKey || !cache.submitted) return cache;
  const wentToTheses = world.thesesVisits > cache.thesesBaseline;
  const filled = cache.basketId != null && world.filledBasketIds.has(cache.basketId);
  if (!wentToTheses && !filled) return cache;
  if (!restore && !wentToTheses && cache.dialogOpen) {
    return cache.invalidated ? cache : { ...cache, invalidated: true };
  }
  const cleared: StudioCache = { ...emptyStudioCache(), thesesBaseline: world.thesesVisits };
  return sameCache(cleared, cache) ? cache : cleared;
}

/** True once an order has actually filled, not merely been accepted by the broker. */
export function executionHasFill(execution: {
  status: ExecutionStatus;
  legs: { status: LegStatus; filledUnits: number | null }[];
}): boolean {
  if (execution.status === "completed" || execution.status === "partial") return true;
  return execution.legs.some((leg) => leg.status === "executed" || leg.status === "partial" || (leg.filledUnits ?? 0) > 0);
}

let world: StudioWorld = emptyStudioWorld();
const listeners = new Set<() => void>();

export function getStudioWorld(): StudioWorld {
  return world;
}

export function subscribeStudioWorld(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener();
}

export function noteThesesVisit() {
  world = { ...world, thesesVisits: world.thesesVisits + 1 };
  emit();
}

export function noteBasketFilled(basketId: string) {
  if (world.filledBasketIds.has(basketId)) return;
  const filledBasketIds = new Set(world.filledBasketIds);
  filledBasketIds.add(basketId);
  world = { ...world, filledBasketIds };
  emit();
}

export function applyStudioWorld(cache: StudioCache, restore = false): StudioCache {
  return reconcileStudioCache(cache, world, restore);
}

/** Tests only: the world is one per browser tab. */
export function resetStudioWorld() {
  world = emptyStudioWorld();
  emit();
}
