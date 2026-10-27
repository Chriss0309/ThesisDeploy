import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { drainExecution } from "@/lib/execution/drain";
import { createExecution, preflightForGuest, requireExecution, retryLeg } from "@/lib/execution/service";
import type { Actor } from "@/lib/execution/store";
import { THESIS_PRESETS } from "@/lib/presets";
import { WINDOW_DAYS, globalTelemetry, resetTelemetryCache, telemetrySnapshot } from "@/lib/telemetry/metrics";
import { servedToGuest } from "@/lib/thesis/edits";
import { createDemoThesis } from "@/lib/thesis/service";
import { recordEvent } from "@/lib/telemetry/events";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-10-24T16:00:00Z");
const DAY_MS = 24 * 3600 * 1000;
const PRESET = THESIS_PRESETS.find((preset) => preset.key === "ai-power-nuclear")!;
const OLD = new Date(NOW.getTime() - (WINDOW_DAYS + 5) * DAY_MS);
const RECENT = new Date(NOW.getTime() - DAY_MS);

describe.skipIf(!TEST_DATABASE_URL)("telemetry aggregates against Postgres", () => {
  beforeAll(() => {
    vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("base64"));
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
  });

  afterAll(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await getDb().$executeRaw`truncate app_users, sessions, oauth_login_attempts, oauth_grants, events, api_calls, account_snapshots, theses, thesis_candidates, baskets, basket_constituents, executions, execution_legs, account_pacing restart identity cascade`;
    resetTelemetryCache();
  });

  async function seed() {
    const db = getDb();
    const [a, b, c] = await Promise.all(
      ["sub-a", "sub-b", "sub-c"].map((sub) => db.appUser.create({ data: { snaptradeUserId: sub }, select: { id: true } })),
    );
    const [t1, t2] = [randomUUID(), randomUUID()];
    const event = (name: string, owner: { userId?: string; guestKey?: string }, props: object = {}, createdAt = RECENT) => ({
      name,
      userId: owner.userId ?? null,
      guestKey: owner.guestKey ?? null,
      props,
      createdAt,
    });
    const A = { userId: a.id };
    const edit = (ref: string, action: string, symbol: string) =>
      event("basket_edited", A, { thesisId: ref, action, symbol });
    // Legs recorded before My Theses carry no kind and count as deploys.
    const leg = (status: string, kind?: string) =>
      event("leg_result", A, { status, mode: "paper", brokerage: "ALPACA-PAPER", ...(kind && { kind }) });
    await db.event.createMany({
      data: [
        event("oauth_connected", A),
        event("thesis_generated", A, { ref: t1 }),
        event("thesis_generated", A, { ref: t2 }),
        event("symbols_resolved", A, { guest: false, proposed: 8, resolved: 7, dropped: { not_found: 1 } }),
        event("symbols_resolved", A, { guest: false, proposed: 7, resolved: 6, dropped: { currency_mismatch: 1 } }),
        // Removed then restored: not an edit. Three slider moves: one edit.
        edit(t1, "remove", "CEG"),
        edit(t1, "restore", "CEG"),
        edit(t1, "reweight", "TLN"),
        edit(t1, "reweight", "TLN"),
        edit(t1, "reweight", "TLN"),
        edit(t1, "step", "BWXT"),
        edit(t2, "remove", "VRT"),
        event("basket_deployed", A),
        leg("executed"),
        leg("executed"),
        leg("rejected"),
        leg("executed"),
        leg("pending"),
        // My Theses: A rebalances (two fills) and closes (one rejected leg).
        event("drift_viewed", A),
        event("drift_viewed", A),
        event("rebalance_confirmed", A),
        leg("executed", "rebalance"),
        leg("executed", "rebalance"),
        leg("rejected", "close"),
        event("basket_closed", A),
        event("oauth_connected", { userId: b.id }),
        // Connected before the window: outside the signed-in funnel, along with what C did next.
        event("oauth_connected", { userId: c.id }, {}, OLD),
        event("thesis_generated", { userId: c.id }),
        event("rebalance_confirmed", { userId: c.id }),
        event("thesis_generated", { guestKey: "guest-1" }),
        event("symbols_resolved", { guestKey: "guest-1" }, { guest: true, proposed: 6, resolved: 6, dropped: {} }),
        event("basket_deployed", { guestKey: "guest-1" }),
        event("drift_viewed", { guestKey: "guest-1" }),
        event("thesis_generated", { guestKey: "guest-2" }),
        event("basket_deployed", { guestKey: "guest-2" }, {}, OLD),
        // guest-2 deployed before the window, so their drift view isn't after a deploy we counted.
        event("drift_viewed", { guestKey: "guest-2" }),
        // Rows from before guest keys existed can't be attributed to anyone.
        event("thesis_generated", {}, { guest: true }),
      ],
    });
    const call = (userId: string, operation: string, latencyMs: number, httpStatus: number | null = 200, createdAt = RECENT) => ({
      userId,
      operation,
      latencyMs,
      httpStatus,
      createdAt,
      accountHash: "hash",
    });
    await db.apiCall.createMany({
      data: [
        ...Array.from({ length: 10 }, (_, i) => call(a.id, "getUserAccountQuotes", (i + 1) * 100)),
        call(a.id, "getUserAccountQuotes", 50, 429),
        call(b.id, "listAllUserAccounts", 300),
        call(b.id, "listAllUserAccounts", 9000, 200, OLD),
      ],
    });
    return { a: a.id, b: b.id };
  }

  it("computes every drawer metric over the window", async () => {
    await seed();
    const all = await telemetrySnapshot(null, NOW);

    expect(all.funnel.signedIn).toEqual({
      connected: 2,
      generated: 1,
      deployed: 1,
      baskets: { generated: 2, deployed: 1 },
      afterDeploy: { viewedDrift: 1, rebalanced: 1, closed: 1 },
    });
    expect(all.funnel.guest).toEqual({
      connected: null,
      generated: 2,
      deployed: 1,
      baskets: { generated: 2, deployed: 1 },
      afterDeploy: { viewedDrift: 1, rebalanced: 0, closed: 0 },
    });

    expect(all.edits).toEqual({ suggested: 19, edited: 3, removed: 1, resized: 2 });

    expect(all.resolution).toEqual([
      {
        source: "snaptrade",
        proposed: 15,
        resolved: 13,
        dropped: [
          { reason: "currency_mismatch", count: 1 },
          { reason: "not_found", count: 1 },
        ],
      },
      { source: "demo", proposed: 6, resolved: 6, dropped: [] },
    ]);

    expect(all.orders).toEqual([
      {
        brokerage: "ALPACA-PAPER",
        mode: "paper",
        orders: 7,
        succeeded: 5,
        byKind: { deploy: 4, rebalance: 2, close: 1 },
      },
    ]);

    expect(all.latency).toEqual([
      { operation: "getUserAccountQuotes", calls: 11, errors: 1, rateLimited: 1, p50Ms: 500, p95Ms: 950 },
      { operation: "listAllUserAccounts", calls: 1, errors: 0, rateLimited: 0, p50Ms: 300, p95Ms: 300 },
    ]);
    expect(all.rateLimits).toEqual({ count: 1, calls: 12, lastAt: RECENT.toISOString() });
  });

  it("scopes to one user or one demo cookie", async () => {
    const { b } = await seed();
    const userB = await telemetrySnapshot({ userId: b, guestKey: null }, NOW);
    expect(userB.funnel.signedIn).toMatchObject({ connected: 1, generated: 0, deployed: 0 });
    expect(userB.funnel.guest.generated).toBe(0);
    expect(userB.latency.map((row) => [row.operation, row.calls])).toEqual([["listAllUserAccounts", 1]]);
    expect(userB.orders).toEqual([]);

    const guest = await telemetrySnapshot({ userId: null, guestKey: "guest-1" }, NOW);
    expect(guest.funnel.guest).toMatchObject({ generated: 1, deployed: 1 });
    expect(guest.funnel.signedIn).toMatchObject({ connected: 0, generated: 0 });
    expect(guest.resolution).toEqual([{ source: "demo", proposed: 6, resolved: 6, dropped: [] }]);
    expect(guest.latency).toEqual([]);
    expect(guest.rateLimits).toEqual({ count: 0, calls: 0, lastAt: null });
  });

  it("counts each Live attempt once, at its latest broker status, next to Paper, and times the trading calls", async () => {
    const db = getDb();
    const { id: userId } = await db.appUser.create({ data: { snaptradeUserId: "sub-live" }, select: { id: true } });
    const [filled, found, refused, retried] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const leg = (legId: string, status: string, source: string, kind = "deploy") => ({
      name: "leg_result",
      userId,
      props: { legId, kind, mode: "live", brokerage: "ALPACA-PAPER", status, source, guest: false },
      createdAt: RECENT,
    });
    await db.event.createMany({
      data: [
        leg(filled, "accepted", "submit"),
        leg(found, "unknown", "submit"),
        leg(refused, "rejected", "submit", "rebalance"),
        leg(filled, "partial", "reconcile"),
        leg(found, "accepted", "reconcile"),
        leg(filled, "executed", "reconcile"),
        leg(found, "executed", "reconcile"),
        leg(retried, "accepted", "submit", "rebalance"),
        { name: "leg_result", userId, props: { legId: randomUUID(), kind: "close", mode: "paper", brokerage: "ALPACA-PAPER", status: "executed" }, createdAt: RECENT },
      ],
    });
    const call = (operation: string, latencyMs: number, httpStatus = 200) => ({ userId, operation, latencyMs, httpStatus, createdAt: RECENT, accountHash: "hash" });
    await db.apiCall.createMany({
      data: [
        call("getOrderImpact", 200),
        call("placeForceOrder", 400),
        call("placeForceOrder", 600, 422),
        call("getUserAccountRecentOrders", 300),
      ],
    });

    const you = await telemetrySnapshot({ userId, guestKey: null }, NOW);
    expect(you.orders).toEqual([
      { brokerage: "ALPACA-PAPER", mode: "live", orders: 4, succeeded: 3, byKind: { deploy: 2, rebalance: 2, close: 0 } },
      { brokerage: "ALPACA-PAPER", mode: "paper", orders: 1, succeeded: 1, byKind: { deploy: 0, rebalance: 0, close: 1 } },
    ]);
    expect(you.latency).toEqual([
      { operation: "placeForceOrder", calls: 2, errors: 1, rateLimited: 0, p50Ms: 500, p95Ms: 590 },
      { operation: "getOrderImpact", calls: 1, errors: 0, rateLimited: 0, p50Ms: 200, p95Ms: 200 },
      { operation: "getUserAccountRecentOrders", calls: 1, errors: 0, rateLimited: 0, p50Ms: 300, p95Ms: 300 },
    ]);
  });

  it("caches everyone's aggregates for a minute", async () => {
    await seed();
    const first = await globalTelemetry(NOW.getTime());
    await getDb().event.create({ data: { name: "oauth_connected", userId: (await getDb().appUser.findFirstOrThrow()).id } });
    expect(await globalTelemetry(NOW.getTime() + 30_000)).toBe(first);
    const fresh = await globalTelemetry(NOW.getTime() + 61_000);
    expect(fresh).not.toBe(first);
  });

  it("attributes a whole guest demo run to the demo cookie", async () => {
    const guestKey = "guest-demo";
    const actor: Actor = { userId: null, guestKey };
    const now = () => NOW;
    const payload = await createDemoThesis(
      { prompt: PRESET.prompt, presetKey: PRESET.key, accountId: "demo-acct-tfsa", currency: "CAD", budget: 2500, overlapMode: "ignore" },
      { client: "client-demo", key: guestKey },
      { now },
    );
    expect(payload.thesis).toMatchObject({ id: null, source: "sample" });
    expect(await servedToGuest(guestKey, payload.thesis.ref)).toBe(true);
    expect(await servedToGuest("someone-else", payload.thesis.ref)).toBe(false);
    const [first] = payload.lines;
    await recordEvent("basket_edited", { ref: payload.thesis.ref, action: "reweight", symbol: first.symbol }, { guestKey });

    const preflight = await preflightForGuest(
      { guestKey, guestClient: "client-demo" },
      {
        thesisId: null,
        accountId: payload.account.id,
        currency: payload.currency,
        budget: payload.budget,
        thesis: { title: payload.thesis.title, summary: payload.thesis.summary, riskProfile: payload.thesis.riskProfile },
        lines: payload.lines.map((line) => ({
          symbol: line.symbol,
          companyName: line.companyName,
          universalSymbolId: line.universalSymbolId,
          targetWeight: line.targetWeight,
          units: line.units,
        })),
      },
      { now },
    );
    const { execution } = await createExecution(
      actor,
      { basketId: preflight.basketId, mode: "paper", simulateRejectSeq: 1, idempotencyKey: randomUUID() },
      { now },
    );
    const drain = async () => {
      for await (const event of drainExecution(await requireExecution(actor, execution.id), { paceMs: 100 })) void event;
    };
    await drain();
    const rejected = (await requireExecution(actor, execution.id)).view.legs.find((leg) => leg.status === "rejected")!;
    await retryLeg(actor, execution.id, rejected.id);
    await drain();

    const rows = await getDb().event.findMany({ where: { name: { not: "thesis_requested" } }, orderBy: { id: "asc" } });
    expect(rows.every((row) => row.guestKey === guestKey && row.userId == null)).toBe(true);
    expect(new Set(rows.map((row) => row.name))).toEqual(
      new Set([
        "thesis_generated",
        "symbols_resolved",
        "basket_edited",
        "preflight_opened",
        "execution_confirmed",
        "leg_result",
        "basket_deployed",
      ]),
    );
    expect(rows.find((row) => row.name === "thesis_generated")!.props).toMatchObject({
      guest: true,
      source: "sample",
      ref: payload.thesis.ref,
      latencyMs: null,
    });

    const mine = await telemetrySnapshot({ userId: null, guestKey }, new Date());
    const orders = preflight.orders.length;
    expect(mine.funnel.guest).toEqual({
      connected: null,
      generated: 1,
      deployed: 1,
      baskets: { generated: 1, deployed: 1 },
      afterDeploy: { viewedDrift: 0, rebalanced: 0, closed: 0 },
    });
    expect(mine.edits).toEqual({ suggested: payload.lines.length, edited: 1, removed: 0, resized: 1 });
    expect(mine.resolution).toEqual([
      expect.objectContaining({ source: "demo", resolved: payload.lines.length }),
    ]);
    expect(mine.orders).toEqual([
      { brokerage: "demo", mode: "paper", orders: orders + 1, succeeded: orders, byKind: { deploy: orders + 1, rebalance: 0, close: 0 } },
    ]);
    expect(mine.latency).toEqual([]);
    expect((await telemetrySnapshot({ userId: null, guestKey: "another-guest" }, new Date())).funnel.guest.generated).toBe(0);
  }, 30_000);
});
