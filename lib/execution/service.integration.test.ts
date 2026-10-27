import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthConfig, type AuthConfig } from "@/lib/auth/config";
import { completeLogin, startLogin } from "@/lib/auth/flow";
import { closeDb, getDb } from "@/lib/db/client";
import { drainExecution, type DrainOptions } from "@/lib/execution/drain";
import { ExecutionError, findBasketView, findExecutionForActor, type Actor } from "@/lib/execution/store";
import {
  GUEST_PREFLIGHTS_PER_DAY,
  cancelExecution,
  createExecution,
  preflightForGuest,
  preflightForUser,
  requireExecution,
  retryLeg,
} from "@/lib/execution/service";
import { summarizeLegs } from "@/lib/execution/summary";
import { PACE_MS, type DrainEvent, type ExecutionView, type PreflightRequest } from "@/lib/execution/types";
import { THESIS_PRESETS } from "@/lib/presets";
import { snapTradeContext, type SnapTradeContext } from "@/lib/snaptrade/client";
import type { ThesisRequest } from "@/lib/thesis/schema";
import { createDemoThesis, createThesis } from "@/lib/thesis/service";
import { SAMPLE_OUTPUTS, mockCreateMessage } from "@/lib/thesis/testing";
import type { ComposerPayload } from "@/lib/thesis/types";
import { startOAuthStub } from "@/scripts/oauth-stub.mjs";
import { startSnapTradeApiStub } from "@/scripts/snaptrade-api-stub.mjs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const REDIRECT_URI = "http://127.0.0.1:3000/api/auth/callback";
// A Saturday: the market is closed and prices are the last trade.
const SATURDAY = new Date("2026-10-24T16:00:00Z");
const now = () => SATURDAY;
const PRESET = THESIS_PRESETS.find((preset) => preset.key === "ai-power-nuclear")!;
const FAST: DrainOptions = { paceMs: 150 };

const thesisRequest = (overrides: Partial<ThesisRequest> = {}): ThesisRequest => ({
  prompt: PRESET.prompt,
  presetKey: PRESET.key,
  accountId: "demo-acct-alpaca-paper",
  currency: "USD",
  budget: 2500,
  overlapMode: "ignore",
  ...overrides,
});

function preflightRequest(payload: ComposerPayload, overrides: Partial<PreflightRequest> = {}): PreflightRequest {
  return {
    thesisId: payload.thesis.id,
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
    ...overrides,
  };
}

async function expectError(promise: Promise<unknown>, code: string, status: number): Promise<ExecutionError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ExecutionError);
  expect(error).toMatchObject({ code, status });
  return error as ExecutionError;
}

async function drain(actor: Actor, executionId: string, options: DrainOptions = FAST) {
  const events: DrainEvent[] = [];
  for await (const event of drainExecution(await requireExecution(actor, executionId), options)) events.push(event);
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("drain ended without a done event");
  return { events, execution: done.execution, reason: done.reason };
}

describe.skipIf(!TEST_DATABASE_URL)("paper execution against stubs and Postgres", () => {
  let oauth: Awaited<ReturnType<typeof startOAuthStub>>;
  let api: Awaited<ReturnType<typeof startSnapTradeApiStub>>;
  let config: AuthConfig;
  let ctx: SnapTradeContext;
  let user: Actor;

  beforeAll(async () => {
    oauth = await startOAuthStub({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
    vi.stubEnv("SNAPTRADE_ISSUER", oauth.issuer);
    vi.stubEnv("SNAPTRADE_OAUTH_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SNAPTRADE_OAUTH_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("SNAPTRADE_OAUTH_REDIRECT_URI", REDIRECT_URI);
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("base64"));
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    config = getAuthConfig();
  });

  afterAll(async () => {
    await oauth?.close();
    await closeDb();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await getDb().$executeRaw`truncate app_users, sessions, oauth_login_attempts, oauth_grants, events, api_calls, account_snapshots, theses, thesis_candidates, baskets, basket_constituents, executions, execution_legs, account_pacing restart identity cascade`;
    api = await startSnapTradeApiStub();
    vi.stubEnv("SNAPTRADE_API_BASE_URL", api.url);
    const { authorizationUrl, state } = await startLogin(config, "/studio");
    const location = new URL((await fetch(authorizationUrl, { redirect: "manual" })).headers.get("location") ?? "");
    const result = await completeLogin(
      config,
      {
        code: location.searchParams.get("code"),
        state: location.searchParams.get("state"),
        error: null,
        iss: location.searchParams.get("iss"),
      },
      state,
    );
    if (!result.ok) throw new Error(`sign-in failed: ${result.error}`);
    ctx = snapTradeContext((await getDb().appUser.findFirstOrThrow()).id);
    user = { userId: ctx.userId, guestKey: null };
  });

  afterEach(async () => {
    // Nothing in this suite may reach a SnapTrade order endpoint.
    expect(Object.keys(api.stats.byPath).filter((path) => /trade|order/i.test(path))).toEqual([]);
    await api.close();
  });

  const events = (name: string) => getDb().event.findMany({ where: { name }, orderBy: { id: "asc" } });

  async function signedInPreflight(overrides: Partial<ThesisRequest> = {}) {
    const payload = await createThesis(ctx, thesisRequest(overrides), {
      createMessage: mockCreateMessage(SAMPLE_OUTPUTS["ai-power-nuclear:USD"]).createMessage,
      now,
    });
    const preflight = await preflightForUser(ctx, preflightRequest(payload), { now });
    return { payload, preflight };
  }

  async function confirm(basketId: string, overrides: { simulateRejectSeq?: number | null; key?: string } = {}) {
    return createExecution(
      user,
      {
        basketId,
        mode: "paper",
        simulateRejectSeq: overrides.simulateRejectSeq ?? null,
        idempotencyKey: overrides.key ?? randomUUID(),
      },
      { now },
    );
  }

  it("prices the confirmed orders with one fresh quotes call and saves a draft basket", async () => {
    const { payload, preflight } = await signedInPreflight();
    const ordered = payload.lines.filter((line) => line.units > 0);

    expect(preflight.orders.map((order) => [order.symbol, order.units])).toEqual(
      ordered.map((line) => [line.symbol, line.units]),
    );
    expect(preflight.orders.every((order) => order.priceBasis === "last")).toBe(true);
    expect(api.stats.quoteRequests.at(-1)).toEqual(ordered.map((line) => line.symbol));
    expect(preflight.market).toMatchObject({ name: "NYSE", open: false });
    expect(preflight.live.available).toBe(false);
    expect(preflight.live.reasons).toEqual(
      expect.arrayContaining([
        "Live trading is switched off on this deployment.",
        expect.stringContaining("NYSE is closed"),
      ]),
    );

    const basket = await getDb().basket.findUniqueOrThrow({
      where: { id: preflight.basketId },
      include: { constituents: true },
    });
    expect(basket).toMatchObject({ userId: ctx.userId, thesisId: payload.thesis.id, status: "draft", mode: null });
    expect(basket.constituents.map((c) => [c.symbol, c.plannedUnits, c.ledgerUnits])).toEqual(
      expect.arrayContaining(ordered.map((line) => [line.symbol, line.units, 0])),
    );
    expect(basket.constituents.reduce((sum, c) => sum + c.targetWeight, 0)).toBeCloseTo(1, 6);
    const [opened] = await events("preflight_opened");
    expect(opened).toMatchObject({ userId: ctx.userId, props: expect.objectContaining({ guest: false, liveAvailable: false }) });
  });

  it("rejects lines that aren't in the user's thesis", async () => {
    const payload = await createThesis(ctx, thesisRequest(), {
      createMessage: mockCreateMessage(SAMPLE_OUTPUTS["ai-power-nuclear:USD"]).createMessage,
      now,
    });
    const request = preflightRequest(payload);
    request.lines[0] = { ...request.lines[0], symbol: "AAPL" };
    await expectError(preflightForUser(ctx, request, { now }), "invalid_request", 400);
  });

  it("paces legs 1.1s apart, keeps going past a rejected leg, and fills the retry", async () => {
    const { preflight } = await signedInPreflight();
    const key = randomUUID();
    const first = await confirm(preflight.basketId, { simulateRejectSeq: 2, key });
    expect(first.created).toBe(true);
    expect(first.execution).toMatchObject({ status: "queued", mode: "paper", simulateRejectSeq: 2 });

    // Same Idempotency-Key: same execution. A second confirmation of the basket: refused.
    const repeat = await confirm(preflight.basketId, { key });
    expect(repeat).toMatchObject({ created: false, execution: { id: first.execution.id } });
    await expectError(confirm(preflight.basketId), "already_executed", 409);

    const run = await drain(user, first.execution.id, {});
    expect(run.reason).toBe("finished");
    expect(run.execution.status).toBe("partial");
    expect(summarizeLegs(run.execution.legs)).toMatchObject({
      orders: preflight.orders.length,
      filled: preflight.orders.length - 1,
      failed: 1,
    });
    const rejected = run.execution.legs.find((leg) => leg.seq === 2)!;
    expect(rejected).toMatchObject({ status: "rejected", errorCode: "simulated_rejection", filledUnits: null });

    const legs = await getDb().executionLeg.findMany({ where: { executionId: first.execution.id }, orderBy: { seq: "asc" } });
    const gaps = legs.slice(1).map((leg, i) => leg.claimedAt!.getTime() - legs[i].claimedAt!.getTime());
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(PACE_MS - 50);

    // The ledger holds fills only, at the pre-flight price.
    let basket = await findBasketView(preflight.basketId, user);
    expect(basket).toMatchObject({ status: "active", mode: "paper" });
    for (const order of preflight.orders) {
      const held = basket!.constituents.find((c) => c.symbol === order.symbol)!;
      expect(held.ledgerUnits).toBe(order.seq === 2 ? 0 : order.units);
      expect(held.costTotal).toBeCloseTo(order.seq === 2 ? 0 : order.units * order.price, 4);
    }

    const retried = await retryLeg(user, first.execution.id, rejected.id);
    expect(retried.status).toBe("running");
    expect(retried.legs.filter((leg) => leg.seq === 2).map((leg) => [leg.attempt, leg.status])).toEqual([
      [1, "rejected"],
      [2, "pending"],
    ]);
    await expectError(retryLeg(user, first.execution.id, rejected.id), "not_retryable", 409);

    const second = await drain(user, first.execution.id);
    expect(second.execution.status).toBe("completed");
    basket = await findBasketView(preflight.basketId, user);
    const order2 = preflight.orders[1];
    expect(basket!.constituents.find((c) => c.symbol === order2.symbol)!.ledgerUnits).toBe(order2.units);

    expect(await events("execution_confirmed")).toHaveLength(1);
    expect(await events("basket_deployed")).toHaveLength(1);
    const results = await events("leg_result");
    expect(results).toHaveLength(preflight.orders.length + 1);
    expect(results.at(-1)!.props).toMatchObject({ status: "executed", attempt: 2, mode: "paper", brokerage: "ALPACA-PAPER" });
  }, 30_000);

  it("allows one active execution per account until it is canceled", async () => {
    const a = await signedInPreflight();
    const first = await confirm(a.preflight.basketId);
    const b = await preflightForUser(ctx, preflightRequest(a.payload), { now });
    const conflict = await expectError(confirm(b.basketId), "execution_active", 409);
    expect(conflict.extra.executionId).toBe(first.execution.id);

    const canceled = await cancelExecution(user, first.execution.id);
    expect(canceled.status).toBe("canceled");
    expect(canceled.legs.every((leg) => leg.status === "skipped")).toBe(true);
    expect((await findBasketView(a.preflight.basketId, user))!.status).toBe("draft");

    const second = await confirm(b.basketId);
    expect(second.created).toBe(true);
    expect((await events("execution_canceled"))[0].props).toMatchObject({ skipped: a.preflight.orders.length });
  });

  it("resumes after the time budget and never fills a leg twice under concurrent drains", async () => {
    const { preflight } = await signedInPreflight();
    const { execution } = await confirm(preflight.basketId);

    const partial = await drain(user, execution.id, { paceMs: 400, budgetMs: 500 });
    expect(partial.reason).toBe("time_budget");
    const afterFirst = summarizeLegs(partial.execution.legs);
    expect(afterFirst.pending).toBeGreaterThan(0);
    expect(partial.execution.status).toBe("running");

    const [x, y] = await Promise.all([drain(user, execution.id, { paceMs: 250 }), drain(user, execution.id, { paceMs: 250 })]);
    const final = [x, y].map((run) => run.execution).find((view) => view.status !== "running") ?? x.execution;
    expect((await requireExecution(user, execution.id)).view.status).toBe("completed");
    expect(summarizeLegs(final.legs).filled).toBe(preflight.orders.length);

    const legs = await getDb().executionLeg.findMany({ where: { executionId: execution.id }, orderBy: { claimedAt: "asc" } });
    expect(legs).toHaveLength(preflight.orders.length);
    const gaps = legs.slice(1).map((leg, i) => leg.claimedAt!.getTime() - legs[i].claimedAt!.getTime());
    for (const gap of gaps.slice(1)) expect(gap).toBeGreaterThanOrEqual(200);
    const basket = await findBasketView(preflight.basketId, user);
    for (const order of preflight.orders) {
      expect(basket!.constituents.find((c) => c.symbol === order.symbol)!.ledgerUnits).toBe(order.units);
    }
    expect(await events("leg_result")).toHaveLength(preflight.orders.length);
  });

  it("stops claiming legs when the client disconnects, and resumes later", async () => {
    const { preflight } = await signedInPreflight();
    const { execution } = await confirm(preflight.basketId);
    const abort = new AbortController();
    let last: ExecutionView | null = null;
    for await (const event of drainExecution(await requireExecution(user, execution.id), { ...FAST, signal: abort.signal })) {
      if (event.type === "leg" && event.leg.status === "executed") abort.abort();
      if (event.type === "done") {
        expect(event.reason).toBe("aborted");
        last = event.execution;
      }
    }
    expect(summarizeLegs(last!.legs).filled).toBe(1);
    expect((await drain(user, execution.id)).execution.status).toBe("completed");
  });

  it("returns paper legs stranded in `claimed` by a dead invocation to the queue", async () => {
    const { preflight } = await signedInPreflight();
    const { execution } = await confirm(preflight.basketId);
    await getDb().executionLeg.updateMany({
      where: { executionId: execution.id, seq: 1 },
      data: { status: "claimed", claimedAt: new Date(Date.now() - 5 * 60_000) },
    });
    const run = await drain(user, execution.id);
    expect(run.execution.status).toBe("completed");
    expect(run.execution.legs.filter((leg) => leg.seq === 1)).toEqual([expect.objectContaining({ status: "executed" })]);
  });

  it("refuses Live in this release and stale pre-flights", async () => {
    const { preflight } = await signedInPreflight();
    const live = { basketId: preflight.basketId, mode: "live" as const, simulateRejectSeq: null };
    await expectError(createExecution(user, { ...live, idempotencyKey: randomUUID() }, { now }), "live_disabled", 403);
    vi.stubEnv("LIVE_TRADING_ENABLED", "true");
    await expectError(createExecution(user, { ...live, idempotencyKey: randomUUID() }, { now }), "live_unavailable", 501);
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");

    const later = () => new Date(SATURDAY.getTime() + 6 * 60_000);
    await expectError(
      createExecution(user, { ...live, mode: "paper", idempotencyKey: randomUUID() }, { now: later }),
      "preflight_stale",
      409,
    );
    expect(await getDb().execution.count()).toBe(0);
  });

  describe("guest demo", () => {
    const guestA = { guestKey: "guest-a", guestClient: "client-a" };
    const guestB = { guestKey: "guest-b", guestClient: "client-b" };
    const actorA: Actor = { userId: null, guestKey: "guest-a" };
    const actorB: Actor = { userId: null, guestKey: "guest-b" };

    async function guestPreflight(guest = guestA) {
      const payload = await createDemoThesis(
        thesisRequest({ accountId: "demo-acct-tfsa", currency: "CAD", budget: 2500 }),
        { client: guest.guestClient },
        { now },
      );
      return preflightForGuest(guest, preflightRequest(payload), { now });
    }

    it("runs on fixture prices, owned by the demo cookie, without SnapTrade", async () => {
      const preflight = await guestPreflight();
      expect(preflight.priceSource).toBe("demo");
      expect(preflight.live.reasons[0]).toContain("Demo accounts are fictional");

      const { execution } = await createExecution(
        actorA,
        { basketId: preflight.basketId, mode: "paper", simulateRejectSeq: null, idempotencyKey: randomUUID() },
        { now },
      );
      expect(execution.basketPath).toBe(`/demo/baskets/${preflight.basketId}`);
      await expectError(retryLeg(actorB, execution.id, execution.legs[0].id), "not_found", 404);
      expect(await findExecutionForActor(execution.id, user)).toBeNull();
      expect(await findBasketView(preflight.basketId, actorB)).toBeNull();

      // Demo accounts are shared fixtures, so pacing and the one-active rule are per guest.
      const other = await guestPreflight(guestB);
      const { execution: otherRun } = await createExecution(
        actorB,
        { basketId: other.basketId, mode: "paper", simulateRejectSeq: null, idempotencyKey: randomUUID() },
        { now },
      );
      const runs = await Promise.all([drain(actorA, execution.id), drain(actorB, otherRun.id)]);
      expect(runs.map((run) => run.execution.status)).toEqual(["completed", "completed"]);
      expect((await findBasketView(preflight.basketId, actorA))!.status).toBe("active");
      expect(api.stats.requests).toBe(0);
      expect((await events("basket_deployed")).map((event) => event.props)).toEqual([
        expect.objectContaining({ guest: true }),
        expect.objectContaining({ guest: true }),
      ]);
    });

    it(`limits pre-flights to ${GUEST_PREFLIGHTS_PER_DAY} per visitor per day`, async () => {
      const preflight = await guestPreflight();
      await getDb().$executeRaw`
        insert into baskets (guest_key, guest_client, account_id, account_name, institution, account_key, currency,
                             budget, title, summary, risk_profile, preflight, preflight_at)
        select guest_key, guest_client, account_id, account_name, institution, account_key, currency,
               budget, title, summary, risk_profile, preflight, preflight_at
        from baskets, generate_series(2, ${GUEST_PREFLIGHTS_PER_DAY})
        where id = ${preflight.basketId}::uuid`;
      await expectError(guestPreflight(), "guest_limit", 429);
      expect((await guestPreflight(guestB)).basketId).toBeTruthy();
    });
  });
});
