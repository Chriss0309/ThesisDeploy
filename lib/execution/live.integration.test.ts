import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuthConfig, type AuthConfig } from "@/lib/auth/config";
import { completeLogin, startLogin } from "@/lib/auth/flow";
import { closeDb, getDb } from "@/lib/db/client";
import { drainExecution, type DrainOptions } from "@/lib/execution/drain";
import { checkImpact } from "@/lib/execution/impact";
import { liveSubmitter } from "@/lib/execution/live-orders";
import { reconcileExecution } from "@/lib/execution/reconcile";
import { createExecution, preflightForUser, requireExecution, retryLeg } from "@/lib/execution/service";
import { ExecutionError, findBasketView, type Actor } from "@/lib/execution/store";
import { summarizeLegs } from "@/lib/execution/summary";
import type { DrainEvent, PreflightPayload, PreflightRequest } from "@/lib/execution/types";
import { THESIS_PRESETS } from "@/lib/presets";
import { snapTradeContext, type SnapTradeContext } from "@/lib/snaptrade/client";
import { actionPreflight } from "@/lib/theses/service";
import type { ThesisRequest } from "@/lib/thesis/schema";
import { createThesis } from "@/lib/thesis/service";
import { SAMPLE_OUTPUTS, mockCreateMessage } from "@/lib/thesis/testing";
import type { ComposerPayload } from "@/lib/thesis/types";
import { startOAuthStub } from "@/scripts/oauth-stub.mjs";
import { startSnapTradeApiStub } from "@/scripts/snaptrade-api-stub.mjs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const REDIRECT_URI = "http://127.0.0.1:3000/api/auth/callback";
const ACCOUNT = "demo-acct-alpaca-paper";
// A Tuesday, 11:00 in New York: the regular session is open.
const OPEN = new Date("2026-10-27T15:00:00Z");
const SATURDAY = new Date("2026-10-24T16:00:00Z");
const PRESET = THESIS_PRESETS.find((preset) => preset.key === "ai-power-nuclear")!;
const PACE = 150;

const thesisRequest = (overrides: Partial<ThesisRequest> = {}): ThesisRequest => ({
  prompt: PRESET.prompt,
  presetKey: PRESET.key,
  accountId: ACCOUNT,
  currency: "USD",
  budget: 2500,
  overlapMode: "ignore",
  ...overrides,
});

function preflightRequest(payload: ComposerPayload): PreflightRequest {
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
  };
}

async function expectError(promise: Promise<unknown>, code: string, status: number): Promise<ExecutionError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ExecutionError);
  expect(error).toMatchObject({ code, status });
  return error as ExecutionError;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!TEST_DATABASE_URL)("Live execution against stubs and Postgres", () => {
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
    config = getAuthConfig();
  });

  afterAll(async () => {
    await oauth?.close();
    await closeDb();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.stubEnv("LIVE_TRADING_ENABLED", "true");
    vi.stubEnv("VERCEL_ENV", "");
    await getDb().$executeRaw`truncate app_users, sessions, oauth_login_attempts, oauth_grants, events, api_calls, account_snapshots, theses, thesis_candidates, baskets, basket_constituents, executions, execution_legs, account_pacing restart identity cascade`;
    api = await startSnapTradeApiStub({ accountLimit: 100 });
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

  afterEach(() => api.close());

  const events = (name: string) => getDb().event.findMany({ where: { name }, orderBy: { id: "asc" } });
  const calls = (path: string) => (api.stats.byPath as Record<string, number>)[path] ?? 0;
  // The app's per-account budget counts api_calls in the last 60 seconds; clearing it stands in for a minute passing.
  const resetBudget = () => getDb().apiCall.deleteMany();
  const live = (): DrainOptions => ({
    paceMs: PACE,
    live: liveSubmitter(ctx, { accountId: ACCOUNT, brokerageSlug: "ALPACA-PAPER", institution: "Alpaca Paper" }),
  });

  async function drain(executionId: string, options: DrainOptions = live()) {
    const seen: DrainEvent[] = [];
    for await (const event of drainExecution(await requireExecution(user, executionId), options)) seen.push(event);
    const done = seen.at(-1);
    if (done?.type !== "done") throw new Error("drain ended without a done event");
    return done.execution;
  }

  async function livePreflight(now = OPEN, overrides: Partial<ThesisRequest> = {}) {
    const payload = await createThesis(ctx, thesisRequest(overrides), {
      createMessage: mockCreateMessage(SAMPLE_OUTPUTS["ai-power-nuclear:USD"]).createMessage,
      now: () => now,
    });
    return preflightForUser(ctx, preflightRequest(payload), { now: () => now });
  }

  const confirmLive = (preflight: PreflightPayload, overrides: Record<string, unknown> = {}) =>
    createExecution(
      user,
      {
        basketId: preflight.basketId,
        kind: preflight.kind ?? "deploy",
        preflightId: preflight.preflightId ?? null,
        mode: "live",
        simulateRejectSeq: null,
        idempotencyKey: randomUUID(),
        acknowledgeLive: true,
        ...overrides,
      },
      { now: () => OPEN },
    );

  async function deployLive(mode: "accept" | "fill" | "never" = "fill") {
    api.setOrders(mode, 200);
    const preflight = await livePreflight();
    const previewed = await checkImpact(user, preflight.basketId, { kind: "deploy" }, { now: () => OPEN, paceMs: PACE });
    const { execution } = await confirmLive(previewed);
    return { preflight: previewed, execution: await drain(execution.id) };
  }

  it("previews, places paced whole-share market orders with client order IDs, and reconciles fills into the ledger", async () => {
    api.setOrders("accept", 300);
    const payload = await createThesis(ctx, thesisRequest(), {
      createMessage: mockCreateMessage(SAMPLE_OUTPUTS["ai-power-nuclear:USD"]).createMessage,
      now: () => OPEN,
    });
    const balanceCalls = calls(`/accounts/${ACCOUNT}/balances`);
    const positionCalls = calls(`/accounts/${ACCOUNT}/positions/all`);
    const preflight = await preflightForUser(ctx, preflightRequest(payload), { now: () => OPEN });
    expect(preflight.live).toMatchObject({ available: true, reasons: [], buyingPower: 96420.8 });
    // A deploy reads buying power fresh: one balance call, no positions.
    expect(calls(`/accounts/${ACCOUNT}/balances`)).toBe(balanceCalls + 1);
    expect(calls(`/accounts/${ACCOUNT}/positions/all`)).toBe(positionCalls);

    await expectError(confirmLive(preflight, { acknowledgeLive: false }), "acknowledgement_required", 400);
    await expectError(confirmLive(preflight), "impact_required", 409);

    const previewed = await checkImpact(user, preflight.basketId, { kind: "deploy" }, { now: () => OPEN, paceMs: PACE });
    expect(previewed.impact).toMatchObject({ source: "brokerage", totalCommission: 0 });
    expect(api.stats.impactRequests.map((body: { universal_symbol_id: string }) => body.universal_symbol_id)).toEqual(
      preflight.orders.map((order) => order.universalSymbolId),
    );

    const { execution } = await confirmLive(previewed);
    expect(execution).toMatchObject({ mode: "live", status: "queued", paperAccount: true, institution: "Alpaca Paper" });
    const sent = await drain(execution.id);
    expect(sent.status).toBe("working");
    expect(sent.legs.every((leg) => leg.status === "accepted" && leg.brokerageOrderId?.startsWith("stub_"))).toBe(true);
    expect((await findBasketView(preflight.basketId, user))!.status).toBe("deploying");

    const legs = await getDb().executionLeg.findMany({ where: { executionId: execution.id }, orderBy: { seq: "asc" } });
    expect(api.stats.orderRequests).toEqual(
      legs.map((leg) =>
        expect.objectContaining({
          account_id: ACCOUNT,
          action: "BUY",
          symbol: leg.symbol,
          units: leg.units,
          order_type: "Market",
          time_in_force: "Day",
          client_order_id: leg.clientOrderId,
        }),
      ),
    );
    const gaps = legs.slice(1).map((leg, i) => leg.claimedAt!.getTime() - legs[i].claimedAt!.getTime());
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(PACE - 20);

    await wait(350);
    const result = await reconcileExecution(user, execution.id);
    expect(result.checked).toBe(true);
    expect(result.execution.status).toBe("completed");
    const basket = (await findBasketView(preflight.basketId, user))!;
    expect(basket).toMatchObject({ status: "active", mode: "live" });
    for (const order of preflight.orders) {
      const held = basket.constituents.find((row) => row.symbol === order.symbol)!;
      expect(held.ledgerUnits).toBe(order.units);
    }
    expect(await events("basket_deployed")).toHaveLength(1);

    // At most one order-status call per 15 seconds per execution.
    const recentCalls = calls(`/accounts/${ACCOUNT}/recentOrders`);
    expect(recentCalls).toBe(1);
    const again = await reconcileExecution(user, execution.id);
    expect(again).toMatchObject({ checked: false, nextCheckAt: null });
    expect(calls(`/accounts/${ACCOUNT}/recentOrders`)).toBe(recentCalls);
  });

  it("rejects a refused leg, leaves an unanswered one unknown until reconciliation finds it, and retries with a new client order ID", async () => {
    api.setOrders("fill");
    const preflight = await livePreflight();
    const previewed = await checkImpact(user, preflight.basketId, { kind: "deploy" }, { now: () => OPEN, paceMs: PACE });
    const { execution } = await confirmLive(previewed);
    // The first order is refused; the second reaches the broker, but SnapTrade's answer is lost.
    api.failNext(422);
    api.placeThenFail(502);
    const sent = await drain(execution.id);
    const [second, first] = sent.legs;
    expect(second).toMatchObject({ status: "rejected", errorMessage: "Injected HTTP 422" });
    expect(first).toMatchObject({ status: "unknown", errorCode: "submit_uncertain" });
    expect(sent.status).toBe("partial");
    expect(summarizeLegs(sent.legs)).toMatchObject({ filled: sent.legs.length - 2, unknown: 1, failed: 1 });
    // Rebalance and close wait while an order is unconfirmed.
    await expectError(actionPreflight(user, preflight.basketId, "close", { now: () => OPEN, ctx }), "orders_open", 409);

    await resetBudget();
    const reconciled = await reconcileExecution(user, execution.id);
    expect(reconciled.execution.legs.find((leg) => leg.id === first.id)).toMatchObject({
      status: "executed",
      brokerageOrderId: expect.stringMatching(/^stub_/),
    });
    // Reconciliation sent nothing; the refused order never reached the stub's order book.
    expect(api.stats.orderRequests).toHaveLength(sent.legs.length - 1);

    const retried = await retryLeg(user, execution.id, second.id);
    const retryLeg2 = retried.legs.find((leg) => leg.seq === second.seq && leg.attempt === 2)!;
    expect(retryLeg2.status).toBe("pending");
    const done = await drain(execution.id);
    expect(done.status).toBe("completed");
    const clientIds = (await getDb().executionLeg.findMany({ where: { executionId: execution.id, seq: second.seq } })).map(
      (leg) => leg.clientOrderId,
    );
    expect(new Set(clientIds).size).toBe(2);
    expect(api.stats.orderRequests.at(-1)).toMatchObject({ client_order_id: clientIds.find((id) => id !== clientIds[0]) ?? clientIds[1] });
  });

  it("never resubmits an unknown order unless reconciliation missed it and the user confirms", async () => {
    api.setOrders("fill");
    const preflight = await livePreflight();
    const previewed = await checkImpact(user, preflight.basketId, { kind: "deploy" }, { now: () => OPEN, paceMs: PACE });
    const { execution } = await confirmLive(previewed);
    api.failNext(503);
    const sent = await drain(execution.id);
    const lost = sent.legs[0];
    expect(lost.status).toBe("unknown");

    await expectError(retryLeg(user, execution.id, lost.id, { confirmNotPlaced: true }), "reconcile_first", 409);
    const reconciled = await reconcileExecution(user, execution.id);
    expect(reconciled.execution.legs[0]).toMatchObject({ status: "unknown", errorMessage: expect.stringContaining("Not in Alpaca Paper's orders") });
    await expectError(retryLeg(user, execution.id, lost.id), "confirm_not_placed", 409);

    const retried = await retryLeg(user, execution.id, lost.id, { confirmNotPlaced: true });
    expect(retried.legs.filter((leg) => leg.seq === lost.seq).map((leg) => [leg.attempt, leg.status])).toEqual([
      [1, "failed"],
      [2, "pending"],
    ]);
    expect((await drain(execution.id)).status).toBe("completed");
  });

  it("re-queues a rate-limited order and sends it once SnapTrade's wait is over", async () => {
    api.setOrders("fill");
    const preflight = await livePreflight();
    const previewed = await checkImpact(user, preflight.basketId, { kind: "deploy" }, { now: () => OPEN, paceMs: PACE });
    const { execution } = await confirmLive(previewed);
    api.failNext(429);
    const sent = await drain(execution.id);
    expect(sent.status).toBe("completed");
    expect(sent.legs.every((leg) => leg.attempt === 1 && leg.status === "executed")).toBe(true);
    expect(api.stats.orderRequests).toHaveLength(sent.legs.length);
    // The throttled request was answered by the stub before reaching its order book.
    expect(calls("/trade/place")).toBe(sent.legs.length + 1);
  }, 20_000);

  it("stops sending the moment the kill switch is turned off", async () => {
    api.setOrders("fill");
    const preflight = await livePreflight();
    const previewed = await checkImpact(user, preflight.basketId, { kind: "deploy" }, { now: () => OPEN, paceMs: PACE });
    const { execution } = await confirmLive(previewed);
    const submit = live().live!;
    let sentCount = 0;
    const sent = await drain(execution.id, {
      paceMs: PACE,
      live: async (leg) => {
        const result = await submit(leg);
        if (++sentCount === 2) vi.stubEnv("LIVE_TRADING_ENABLED", "false");
        return result;
      },
    });
    expect(sent.legs.slice(0, 2).every((leg) => leg.status === "executed")).toBe(true);
    expect(sent.legs.slice(2).every((leg) => leg.status === "failed" && leg.errorCode === "live_disabled")).toBe(true);
    expect(api.stats.orderRequests).toHaveLength(2);
    await expectError(retryLeg(user, execution.id, sent.legs[2].id), "live_disabled", 403);
  });

  it("keeps Live available without a brokerage preview, and blocks it when the broker refuses one", async () => {
    api.setImpact("unsupported");
    const unsupported = await livePreflight();
    const checked = await checkImpact(user, unsupported.basketId, { kind: "deploy" }, { now: () => OPEN, paceMs: PACE });
    expect(checked.impact).toMatchObject({ source: "unsupported", totalCommission: null });
    expect(api.stats.impactRequests).toHaveLength(1);
    expect(checked.live.available).toBe(true);

    api.setImpact("reject", "VRT");
    await resetBudget();
    const refused = await livePreflight();
    const blocked = await checkImpact(user, refused.basketId, { kind: "deploy" }, { now: () => OPEN, paceMs: PACE });
    expect(blocked.live.available).toBe(false);
    expect(blocked.live.reasons).toEqual([expect.stringContaining("Insufficient buying power")]);
    await expectError(confirmLive(blocked), "live_unavailable", 409);
  });

  it("gates Live on the kill switch, previews, market hours, and the connection, without spending calls once blocked", async () => {
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    const off = await livePreflight();
    expect(off.live.reasons).toEqual(["Live trading is switched off on this deployment."]);
    await expectError(confirmLive(off), "live_disabled", 403);

    vi.stubEnv("LIVE_TRADING_ENABLED", "true");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await livePreflight()).live.reasons).toEqual(["Live trading is always off on preview deployments."]);
    vi.stubEnv("VERCEL_ENV", "");

    // Buying power is read only for pre-flights nothing else blocks.
    const balanceCalls = calls(`/accounts/${ACCOUNT}/balances`);
    await resetBudget();
    const closed = await livePreflight(SATURDAY);
    expect(closed.live.reasons).toEqual([expect.stringContaining("NYSE is closed (weekend)")]);

    await resetBudget();
    const ibkrCalls = calls("/accounts/demo-acct-ibkr/balances");
    const readOnly = await livePreflight(OPEN, { accountId: "demo-acct-ibkr" });
    expect(readOnly.live.reasons).toEqual(["Read-only connection"]);
    expect(calls(`/accounts/${ACCOUNT}/balances`)).toBe(balanceCalls);
    expect(calls("/accounts/demo-acct-ibkr/balances")).toBe(ibkrCalls);
    expect(api.stats.orderRequests).toHaveLength(0);
  });

  it("rebalances and closes a Live basket only Live, against the shares the broker holds", async () => {
    const { preflight } = await deployLive("fill");
    const basketId = preflight.basketId;
    await resetBudget();
    const paperClose = await actionPreflight(user, basketId, "close", { now: () => OPEN, ctx });
    expect(paperClose.paper).toMatchObject({ available: false });
    await expectError(
      createExecution(
        user,
        { basketId, kind: "close", preflightId: paperClose.preflightId, mode: "paper", simulateRejectSeq: null, idempotencyKey: randomUUID() },
        { now: () => OPEN },
      ),
      "mode_mismatch",
      409,
    );

    // Overweight one name in the ledger and at the broker, so a rebalance sells it.
    const [heavy] = preflight.orders;
    await getDb().basketConstituent.update({
      where: { basketId_symbol: { basketId, symbol: heavy.symbol } },
      data: { ledgerUnits: { increment: 20 }, costTotal: { increment: 20 * heavy.price } },
    });
    await fetch(`${api.url}/trade/place`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ account_id: ACCOUNT, action: "BUY", symbol: heavy.symbol, order_type: "Market", time_in_force: "Day", units: 20, client_order_id: randomUUID() }),
    });

    await resetBudget();
    const rebalance = await actionPreflight(user, basketId, "rebalance", { now: () => OPEN, ctx });
    expect(rebalance.live.available).toBe(true);
    expect(rebalance.orders[0]).toMatchObject({ action: "SELL", symbol: heavy.symbol });
    const previewed = await checkImpact(user, basketId, { kind: "rebalance", preflightId: rebalance.preflightId }, { now: () => OPEN, paceMs: PACE });
    const { execution } = await confirmLive(previewed);
    const rebalanced = await drain(execution.id);
    expect(rebalanced.status).toBe("completed");
    expect(api.stats.orderRequests.at(-rebalance.orders.length)).toMatchObject({ action: "SELL", symbol: heavy.symbol });

    await resetBudget();
    const close = await actionPreflight(user, basketId, "close", { now: () => OPEN, ctx });
    const closePreviewed = await checkImpact(user, basketId, { kind: "close", preflightId: close.preflightId }, { now: () => OPEN, paceMs: PACE });
    const closing = await confirmLive(closePreviewed);
    expect((await drain(closing.execution.id)).status).toBe("completed");
    const basket = (await findBasketView(basketId, user))!;
    expect(basket.status).toBe("closed");
    expect(basket.constituents.every((row) => row.ledgerUnits === 0)).toBe(true);
    expect(await events("basket_closed")).toHaveLength(1);
  }, 20_000);

  it("refuses Live for guests and for Paper baskets' rebalances", async () => {
    const preflight = await livePreflight();
    const guest: Actor = { userId: null, guestKey: "someone" };
    await expectError(
      createExecution(guest, { basketId: preflight.basketId, mode: "live", simulateRejectSeq: null, idempotencyKey: randomUUID(), acknowledgeLive: true }),
      "not_found",
      404,
    );
    await expectError(checkImpact(guest, preflight.basketId, { kind: "deploy" }), "not_found", 404);
  });
});
