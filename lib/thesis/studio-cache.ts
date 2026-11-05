import type { BasketCurrency, OverlapMode } from "@/constants/thesis";
import type { EditableLine } from "@/lib/thesis/composer-state";
import type { ExecutionStatus, LegStatus } from "@/types/execution";
import type { ComposerPayload } from "@/types/thesis";

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

export type StudioScope = "demo" | `live:${string}`;

export const STUDIO_SNAPSHOT_KEY = { demo: "thesisdeploy.studio.demo", live: "thesisdeploy.studio.live" } as const;

export const STUDIO_SNAPSHOT_TTL_MS = 24 * 3600 * 1000;

export type StudioForm = { accountId: string; currency: BasketCurrency; budget: number; overlapMode: OverlapMode };

export type StudioSnapshot = {
  v: 1;
  scope: StudioScope;
  savedAt: number;
  prompt: string;
  presetKey: string | null;
  form: StudioForm;
  interrupted: boolean;
  payload: ComposerPayload | null;
  lines: EditableLine[] | null;
};

export function studioSnapshot(studio: {
  scope: StudioScope;
  now: number;
  prompt: string;
  presetKey: string | null;
  form: StudioForm;
  generating: boolean;
  cache: StudioCache;
  payload: ComposerPayload | null;
  arrived: ComposerPayload | null;
  lines: EditableLine[] | null;
}): StudioSnapshot | null {
  const { scope, cache, payload, arrived } = studio;
  const guestConfirming = scope === "demo" && cache.dialogOpen;
  const keep = payload != null && canExecuteStudioBasket(cache) && !guestConfirming;
  const basket = arrived ? { payload: arrived, lines: null } : keep ? { payload, lines: studio.lines } : null;
  if (!basket && !studio.generating) return null;
  return {
    v: 1,
    scope,
    savedAt: studio.now,
    prompt: studio.prompt,
    presetKey: studio.presetKey,
    form: studio.form,
    interrupted: studio.generating && !arrived,
    payload: basket?.payload ?? null,
    lines: basket?.lines ?? null,
  };
}

export function readStudioSnapshot(
  raw: string | null,
  expected: { scope: StudioScope; now: number; accountIds: readonly string[] },
): StudioSnapshot | null {
  let snapshot: StudioSnapshot | null;
  try {
    snapshot = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (snapshot?.v !== 1 || snapshot.scope !== expected.scope) return null;
  if (!(expected.now - snapshot.savedAt < STUDIO_SNAPSHOT_TTL_MS)) return null;
  const { form, payload, lines } = snapshot;
  const accountIds = payload ? [form?.accountId, payload.account?.id] : [form?.accountId];
  if (!accountIds.every((id) => expected.accountIds.includes(id))) return null;
  if (lines && !(payload && sameSymbols(lines, payload.lines))) return null;
  return snapshot;
}

function sameSymbols(lines: readonly EditableLine[], generated: readonly { symbol: string }[]): boolean {
  return (
    Array.isArray(lines) &&
    Array.isArray(generated) &&
    lines.length === generated.length &&
    lines.every((line, i) => line?.symbol === generated[i]?.symbol)
  );
}

export function takeStudioSnapshot(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    localStorage.removeItem(key);
    return raw;
  } catch {
    return null;
  }
}

export function dropExpiredStudioSnapshots(now: number) {
  for (const key of Object.values(STUDIO_SNAPSHOT_KEY)) {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null && !(now - Number(JSON.parse(raw)?.savedAt) < STUDIO_SNAPSHOT_TTL_MS)) {
        localStorage.removeItem(key);
      }
    } catch {
      writeStudioSnapshot(key, null);
    }
  }
}

export function writeStudioSnapshot(key: string, snapshot: StudioSnapshot | null) {
  try {
    if (snapshot) localStorage.setItem(key, JSON.stringify(snapshot));
    else localStorage.removeItem(key);
  } catch {
    // Blocked or full storage: the basket still lives in this tab, it just won't survive a reload.
  }
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
