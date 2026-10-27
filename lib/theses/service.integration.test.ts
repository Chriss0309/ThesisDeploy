import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthConfig, type AuthConfig } from "@/lib/auth/config";
import { completeLogin, startLogin } from "@/lib/auth/flow";
import { closeDb, getDb } from "@/lib/db/client";
import { drainExecution, type DrainOptions } from "@/lib/execution/drain";
import { ExecutionError, findBasketView, type Actor } from "@/lib/execution/store";
import { createExecution, preflightForGuest, preflightForUser, requireExecution, retryLeg } from "@/lib/execution/service";
import type { DrainEvent, PreflightRequest } from "@/lib/execution/types";
import { THESIS_PRESETS } from "@/lib/presets";
import { snapTradeContext, type SnapTradeContext } from "@/lib/snaptrade/client";
import type { ThesisRequest } from "@/lib/thesis/schema";
import { createDemoThesis, createThesis } from "@/lib/thesis/service";
import { SAMPLE_OUTPUTS, mockCreateMessage } from "@/lib/thesis/testing";
import type { ComposerPayload } from "@/lib/thesis/types";
import { startOAuthStub } from "@/scripts/oauth-stub.mjs";
import { actionPreflight, loadTheses, recordDriftViewed, simulateMove } from "@/lib/theses/service";
import { startSnapTradeApiStub } from "@/scripts/snaptrade-api-stub.mjs";
import quotesFixture from "@/lib/thesis/demo-quotes.json";

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

describe.skipIf(!TEST_DATABASE_URL)("My Theses against stubs and Postgres", () => {
  let oauth: Awaited<ReturnType<typeof startOAuthStub>>;
  let api: Awaited<ReturnType<typeof startSnapTradeApiStub>>;
  const stubs: (typeof api)[] = [];
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

  async function useStub(options: Parameters<typeof startSnapTradeApiStub>[0] = {}) {
    api = await startSnapTradeApiStub(options);
    stubs.push(api);
    vi.stubEnv("SNAPTRADE_API_BASE_URL", api.url);
    if (ctx) ctx = { ...ctx, apiBaseUrl: api.url };
  }

  beforeEach(async () => {
    await getDb().$executeRaw`truncate app_users, sessions, oauth_login_attempts, oauth_grants, events, api_calls, account_snapshots, theses, thesis_candidates, baskets, basket_constituents, executions, execution_legs, account_pacing restart identity cascade`;
    await useStub();
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
    for (const stub of stubs.splice(0)) {
      expect(Object.keys(stub.stats.byPath).filter((path) => /trade|order/i.test(path))).toEqual([]);
      await stub.close();
    }
  });

  const events = (name: string) => getDb().event.findMany({ where: { name }, orderBy: { id: "asc" } });
  const at = (minutes: number) => new Date(SATURDAY.getTime() + minutes * 60_000);

  /** Quotes with one ticker's prices scaled, the way a market move would. */
  const movedQuotes = (symbol: string, factor: number) =>
    (quotesFixture.quotes as { symbol: { symbol: string }; last_trade_price: number; bid_price: number; ask_price: number }[]).map(
      (quote) =>
        quote.symbol.symbol === symbol
          ? {
              ...quote,
              last_trade_price: quote.last_trade_price * factor,
              bid_price: quote.bid_price * factor,
              ask_price: quote.ask_price * factor,
            }
          : quote,
    );

  async function deployedBasket() {
    const payload = await createThesis(ctx, thesisRequest(), {
      createMessage: mockCreateMessage(SAMPLE_OUTPUTS["ai-power-nuclear:USD"]).createMessage,
      now,
    });
    const preflight = await preflightForUser(ctx, preflightRequest(payload), { now });
    const { execution } = await createExecution(
      user,
      { basketId: preflight.basketId, mode: "paper", simulateRejectSeq: null, idempotencyKey: randomUUID() },
      { now },
    );
    expect((await drain(user, execution.id)).execution.status).toBe("completed");
    return preflight;
  }

  async function confirmAction(
    actor: Actor,
    preflight: Awaited<ReturnType<typeof actionPreflight>>,
    overrides: { key?: string; preflightId?: string } = {},
  ) {
    return createExecution(
      actor,
      {
        basketId: preflight.basketId,
        kind: preflight.kind,
        preflightId: overrides.preflightId ?? preflight.preflightId,
        mode: "paper",
        simulateRejectSeq: null,
        idempotencyKey: overrides.key ?? randomUUID(),
      },
      { now: () => new Date(preflight.preparedAt) },
    );
  }

  it("values a deployed basket from fresh quotes, caches them, and falls back to cached prices", async () => {
    const deployed = await deployedBasket();
    const quoteCalls = () => api.stats.quoteRequests.length;

    const first = (await loadTheses(user, { ctx, now: at(1) })).cards[0];
    expect(first).toMatchObject({ id: deployed.basketId, status: "active", currency: "USD" });
    const calls = quoteCalls();
    // Fills were at the last trade, so on the same prices value equals cost.
    expect(first.valuation!.holdingsValue).toBeCloseTo(first.valuation!.costBasis, 2);
    expect(first.valuation!.totalReturn).toBeCloseTo(0, 2);
    expect(first.valuation!.rebalanceRecommended).toBe(false);
    expect(first.pricing).toMatchObject({ source: "snaptrade", stale: false, problem: null });

    await loadTheses(user, { ctx, now: at(1.5) });
    expect(quoteCalls()).toBe(calls);

    await api.close();
    const stale = (await loadTheses(user, { ctx, now: at(5) })).cards[0];
    expect(stale.pricing.stale).toBe(true);
    expect(stale.pricing.problem).toContain("couldn't price");
    expect(stale.valuation).not.toBeNull();
  });

  it("flags drift, rebalances sells before buys through the paced queue, then closes", async () => {
    const deployed = await deployedBasket();
    const symbol = [...deployed.orders].sort((a, b) => b.units - a.units)[0].symbol;
    await useStub({ quotes: movedQuotes(symbol, 2) as never });

    const { cards } = await loadTheses(user, { ctx, now: at(10) });
    const card = cards[0];
    expect(card.valuation!.rebalanceRecommended).toBe(true);
    expect(card.valuation!.maxAbsDrift).toBeGreaterThan(0.05);
    expect(card.valuation!.lines.find((line) => line.symbol === symbol)!.drift).toBeGreaterThan(0.05);
    expect(card.valuation!.unrealized).toBeGreaterThan(0);
    await recordDriftViewed(cards, { userId: ctx.userId });
    expect((await events("drift_viewed"))[0]).toMatchObject({
      userId: ctx.userId,
      props: expect.objectContaining({ baskets: 1, flagged: 1, guest: false }),
    });

    const plan = await actionPreflight(user, deployed.basketId, "rebalance", { now: () => at(10) });
    expect(plan).toMatchObject({ kind: "rebalance", priceSource: "snaptrade" });
    const actions = plan.orders.map((order) => order.action);
    expect(actions[0]).toBe("SELL");
    expect(actions).toEqual([...actions].sort((a, b) => (a === b ? 0 : a === "SELL" ? -1 : 1)));
    expect(plan.orders.find((order) => order.symbol === symbol)!.action).toBe("SELL");
    expect(plan.totals.estCost).toBeLessThanOrEqual(plan.totals.sellProceeds! + 1e-6);
    expect(plan.rebalance!.maxDriftAfter).toBeLessThan(plan.rebalance!.maxDriftBefore);

    // Replaced pre-flights and Live are refused; the right one runs once.
    const key = randomUUID();
    await expectError(confirmAction(user, plan, { preflightId: randomUUID(), key }), "preflight_stale", 409);
    await expectError(
      createExecution(user, { basketId: plan.basketId, kind: "rebalance", preflightId: plan.preflightId, mode: "live", simulateRejectSeq: null, idempotencyKey: randomUUID() }),
      "live_disabled",
      403,
    );
    const confirmed = await confirmAction(user, plan, { key });
    expect(confirmed.created).toBe(true);
    expect(confirmed.execution).toMatchObject({ kind: "rebalance", status: "queued" });
    expect(await confirmAction(user, plan, { key })).toMatchObject({ created: false, execution: { id: confirmed.execution.id } });
    await expectError(confirmAction(user, plan), "preflight_used", 409);
    await expectError(actionPreflight(user, deployed.basketId, "close", { now: () => at(10) }), "execution_active", 409);

    const run = await drain(user, confirmed.execution.id);
    expect(run.execution.status).toBe("completed");
    const legs = await getDb().executionLeg.findMany({ where: { executionId: confirmed.execution.id }, orderBy: { claimedAt: "asc" } });
    const order = legs.map((leg) => leg.action);
    expect(order).toEqual([...order].sort((a, b) => (a === b ? 0 : a === "SELL" ? -1 : 1)));

    const rebalanced = await findBasketView(deployed.basketId, user);
    const basket = await getDb().basket.findUniqueOrThrow({ where: { id: deployed.basketId } });
    expect(basket.status).toBe("active");
    expect(basket.cash.toNumber()).toBeGreaterThanOrEqual(-1e-6);
    const sold = plan.orders.find((o) => o.symbol === symbol)!;
    const row = rebalanced!.constituents.find((c) => c.symbol === symbol)!;
    expect(row.ledgerUnits).toBe(deployed.orders.find((o) => o.symbol === symbol)!.units - sold.units);
    expect(row.realizedTotal).toBeGreaterThan(0);
    expect(basket.contributed.toNumber()).toBeCloseTo(deployed.totals.estCost, 2);
    const reloaded = (await loadTheses(user, { ctx, now: at(20) })).cards[0];
    expect(reloaded.valuation!.maxAbsDrift).toBeLessThan(card.valuation!.maxAbsDrift);
    expect(reloaded.execution).toBeNull();
    const confirmedEvent = (await events("rebalance_confirmed"))[0];
    expect(confirmedEvent.props).toMatchObject({ sells: expect.any(Number), buys: expect.any(Number), guest: false, currency: "USD" });

    // Close sells every share, banks the cash, and closes the basket once.
    const close = await actionPreflight(user, deployed.basketId, "close", { now: () => at(21) });
    expect(close.orders.every((o) => o.action === "SELL")).toBe(true);
    const closing = await confirmAction(user, close);
    const closed = await drain(user, closing.execution.id);
    expect(closed.execution).toMatchObject({ kind: "close", status: "completed" });
    const after = await getDb().basket.findUniqueOrThrow({ where: { id: deployed.basketId }, include: { constituents: true } });
    expect(after.status).toBe("closed");
    expect(after.closedAt).not.toBeNull();
    expect(after.constituents.every((c) => c.ledgerUnits === 0 && c.costTotal.toNumber() === 0)).toBe(true);
    const finalCard = (await loadTheses(user, { ctx, now: at(22) })).cards[0];
    expect(finalCard.status).toBe("closed");
    expect(finalCard.valuation!.holdingsValue).toBe(0);
    expect(finalCard.valuation!.totalValue).toBeCloseTo(after.cash.toNumber(), 2);
    expect(finalCard.valuation!.totalReturn).toBeCloseTo(finalCard.valuation!.realized, 2);
    expect(await events("basket_closed")).toHaveLength(1);
    await expectError(actionPreflight(user, deployed.basketId, "rebalance", { now: () => at(23) }), "not_active", 409);
  }, 60_000);

  it("keeps a partly failed close open, retries the leg, and closes when the last share is sold", async () => {
    const deployed = await deployedBasket();
    const close = await actionPreflight(user, deployed.basketId, "close", { now });
    const { execution } = await createExecution(
      user,
      {
        basketId: close.basketId,
        kind: "close",
        preflightId: close.preflightId,
        mode: "paper",
        simulateRejectSeq: 2,
        idempotencyKey: randomUUID(),
      },
      { now },
    );
    const run = await drain(user, execution.id);
    expect(run.execution.status).toBe("partial");
    expect((await getDb().basket.findUniqueOrThrow({ where: { id: deployed.basketId } })).status).toBe("active");
    expect(await events("basket_closed")).toHaveLength(0);

    const rejected = run.execution.legs.find((leg) => leg.status === "rejected")!;
    await retryLeg(user, execution.id, rejected.id);
    expect((await drain(user, execution.id)).execution.status).toBe("completed");
    expect((await getDb().basket.findUniqueOrThrow({ where: { id: deployed.basketId } })).status).toBe("closed");
    expect(await events("basket_closed")).toHaveLength(1);
  }, 60_000);

  it("refuses rebalancing a basket that isn't ready or isn't yours", async () => {
    const deployed = await deployedBasket();
    const stranger: Actor = { userId: randomUUID(), guestKey: null };
    await expectError(actionPreflight(stranger, deployed.basketId, "close", { now }), "not_found", 404);
    await getDb().basket.update({ where: { id: deployed.basketId }, data: { status: "deploying" } });
    await expectError(actionPreflight(user, deployed.basketId, "close", { now }), "not_active", 409);
  });

  describe("guest demo", () => {
    const guest = { guestKey: "guest-a", guestClient: "client-a" };
    const actor: Actor = { userId: null, guestKey: "guest-a" };

    async function guestBasket() {
      const payload = await createDemoThesis(
        thesisRequest({ accountId: "demo-acct-tfsa", currency: "CAD", budget: 2500 }),
        { client: guest.guestClient },
        { now },
      );
      const preflight = await preflightForGuest(guest, preflightRequest(payload), { now });
      const { execution } = await createExecution(
        actor,
        { basketId: preflight.basketId, mode: "paper", simulateRejectSeq: null, idempotencyKey: randomUUID() },
        { now },
      );
      await drain(actor, execution.id);
      return preflight;
    }

    it("simulates a market move, flags drift, rebalances and closes on fixtures without SnapTrade", async () => {
      const deployed = await guestBasket();
      const symbol = deployed.orders[0].symbol;
      expect((await loadTheses(actor)).cards[0].valuation!.rebalanceRecommended).toBe(false);

      await expectError(simulateMove({ userId: null, guestKey: "guest-b" }, deployed.basketId, { reset: true }), "not_found", 404);
      await expectError(simulateMove(actor, deployed.basketId, { symbol: "NOPE", change: 0.4 }), "invalid_request", 400);
      expect(await simulateMove(actor, deployed.basketId, { symbol, change: 0.6 })).toEqual({ [symbol]: 1.6 });
      const moved = (await loadTheses(actor)).cards[0];
      expect(moved.valuation!.rebalanceRecommended).toBe(true);
      expect(moved.simulatedMoves).toEqual({ [symbol]: 1.6 });
      expect(moved.pricing.source).toBe("demo");
      await recordDriftViewed([moved], { guestKey: actor.guestKey });

      const plan = await actionPreflight(actor, deployed.basketId, "rebalance", { now });
      expect(plan).toMatchObject({ priceSource: "demo", kind: "rebalance" });
      expect(plan.orders[0].action).toBe("SELL");
      const { execution } = await confirmAction(actor, plan);
      expect((await drain(actor, execution.id)).execution.status).toBe("completed");
      expect((await loadTheses(actor)).cards[0].valuation!.maxAbsDrift).toBeLessThan(moved.valuation!.maxAbsDrift);

      expect(await simulateMove(actor, deployed.basketId, { reset: true })).toBeNull();
      const close = await actionPreflight(actor, deployed.basketId, "close", { now });
      const closing = await confirmAction(actor, close);
      expect((await drain(actor, closing.execution.id)).execution.status).toBe("completed");
      expect((await loadTheses(actor)).cards[0].status).toBe("closed");
      expect(api.stats.requests).toBe(0);
      expect((await events("rebalance_confirmed"))[0].props).toMatchObject({ guest: true });
      expect((await events("basket_closed"))[0].props).toMatchObject({ guest: true });

      // Every My Theses event belongs to the demo cookie, so the telemetry drawer's "You" view sees it.
      for (const name of ["drift_viewed", "preflight_opened", "execution_confirmed", "rebalance_confirmed", "leg_result", "basket_closed"]) {
        const rows = await events(name);
        expect(rows.length, name).toBeGreaterThan(0);
        expect(rows.every((row) => row.guestKey === actor.guestKey && row.userId == null), name).toBe(true);
      }
      const kinds = new Set((await events("leg_result")).map((row) => (row.props as { kind?: string }).kind));
      expect(kinds).toEqual(new Set(["deploy", "rebalance", "close"]));
    }, 60_000);
  });
});
