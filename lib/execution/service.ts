import { createHash } from "node:crypto";

import type { SymbolsQuotesInner } from "snaptrade-typescript-sdk";

import { getDb } from "@/lib/db/client";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { buildPreflight, type PreflightInput } from "@/lib/execution/preflight";
import {
  ExecutionError,
  cancelPending,
  findExecutionForActor,
  findOwnedBasket,
  guestUsage,
  insertExecution,
  loadExecutionView,
  queueRetry,
  saveDraftBasket,
  type Actor,
} from "@/lib/execution/store";
import { PREFLIGHT_TTL_MS, type ExecutionView, type PreflightPayload, type PreflightRequest } from "@/lib/execution/types";
import type { Prisma } from "@/lib/generated/prisma/client";
import { marketForCurrency, marketStatus } from "@/lib/market-hours";
import { demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";
import { loadOverview } from "@/lib/portfolio/service";
import type { CashBalance, PortfolioAccount } from "@/lib/portfolio/types";
import { SnapTradeError, hashAccountId, type SnapTradeContext } from "@/lib/snaptrade/client";
import type { Quote } from "@/lib/solver";
import { recordEvent } from "@/lib/telemetry/events";
import { DEMO_QUOTES, demoQuoteSource, snapTradeQuoteSource } from "@/lib/thesis/quote-sources";
import type { RiskProfile } from "@/lib/thesis/schema";

/** Demo limits per visitor (keyed IP) and across all guests, per rolling 24 hours. */
export const GUEST_PREFLIGHTS_PER_DAY = 60;
export const GUEST_PAPER_RUNS_PER_DAY = 20;
export const GUEST_PAPER_RUNS_GLOBAL_PER_DAY = 1000;

export type GuestIdentity = { guestKey: string; guestClient: string };

function quoteMap(quotes: readonly SymbolsQuotesInner[]): Map<string, Quote> {
  return new Map(
    quotes.flatMap((quote) =>
      quote.symbol
        ? [[quote.symbol.symbol.toUpperCase(), { last: quote.last_trade_price, bid: quote.bid_price, ask: quote.ask_price }]]
        : [],
    ),
  );
}

const cashIn = (balances: readonly CashBalance[] | undefined, currency: string) =>
  balances?.find((balance) => balance.currency.toUpperCase() === currency)?.cash ?? null;

function quoteFailure(error: unknown): ExecutionError {
  if (error instanceof SnapTradeError && (error.code === "rate_limited" || error.code === "budget_exhausted")) {
    const wait = Math.max(1, Math.ceil(error.retryAfterSeconds ?? 60));
    return new ExecutionError(
      "rate_limited",
      429,
      `This account's SnapTrade request limit (10 per minute) is used up. Try pre-flight again in ${wait} seconds.`,
      { retryAfterSeconds: wait },
    );
  }
  console.error("[preflight] quotes failed", describeError(error));
  return new ExecutionError("snaptrade_unavailable", 502, "SnapTrade couldn't price the orders. Try again shortly.");
}

function marketFor(currency: string, now: Date) {
  return marketStatus(marketForCurrency(currency) ?? "NYSE", now);
}

type Assembled = {
  request: PreflightRequest;
  input: PreflightInput;
  owner: { userId: string | null; guestKey: string | null; guestClient: string | null };
  thesisId: string | null;
  thesis: { title: string; summary: string; riskProfile: RiskProfile };
  account: PortfolioAccount;
  accountKey: string;
  now: Date;
};

async function finishPreflight(a: Assembled): Promise<PreflightPayload> {
  const built = buildPreflight(a.input);
  if (built.orders.length === 0) {
    throw new ExecutionError("nothing_to_order", 422, "None of these lines has shares to buy at a current price.");
  }
  const expiresAt = new Date(a.now.getTime() + PREFLIGHT_TTL_MS);
  const snapshot = { ...built, title: a.thesis.title, preparedAt: a.now.toISOString(), expiresAt: expiresAt.toISOString() };
  const basketId = await saveDraftBasket({
    basketId: a.request.basketId,
    owner: a.owner,
    thesisId: a.thesisId,
    account: {
      id: a.account.id,
      name: a.account.name,
      institution: a.account.institution,
      brokerageSlug: a.account.brokerageSlug,
    },
    accountKey: a.accountKey,
    currency: a.request.currency,
    budget: a.request.budget,
    thesis: a.thesis,
    preflight: snapshot as unknown as Prisma.InputJsonObject,
    preparedAt: a.now,
    orders: built.orders,
  });
  await recordEvent(
    "preflight_opened",
    {
      basketId,
      thesisId: a.thesisId,
      guest: a.owner.userId == null,
      orders: built.orders.length,
      leftOut: built.leftOut.length,
      currency: a.request.currency,
      marketOpen: built.market.open,
      liveAvailable: built.live.available,
    },
    a.owner.userId ?? undefined,
  );
  return { basketId, ...snapshot };
}

/**
 * Signed-in pre-flight: the lines must come from the user's own thesis, the
 * account is re-read from SnapTrade (not account-limited), and the orders are
 * priced with one fresh quotes call (account-limited, budget-checked).
 */
export async function preflightForUser(
  ctx: SnapTradeContext,
  request: PreflightRequest,
  deps: { now?: () => Date } = {},
): Promise<PreflightPayload> {
  if (!request.thesisId) throw new ExecutionError("invalid_request", 400, "Generate a thesis before pre-flight.");
  const thesis = await getDb().thesis.findFirst({
    where: { id: request.thesisId, userId: ctx.userId },
    include: { candidates: { where: { resolutionStatus: "resolved" } } },
  });
  if (!thesis) throw new ExecutionError("not_found", 404, "Thesis not found.");
  if (thesis.accountId !== request.accountId || thesis.currency !== request.currency) {
    throw new ExecutionError("invalid_request", 400, "The basket's account or currency doesn't match its thesis.");
  }
  const bySymbol = new Map(thesis.candidates.flatMap((c) => (c.symbol ? [[c.symbol.toUpperCase(), c]] : [])));
  const lines = request.lines.map((line) => {
    const candidate = bySymbol.get(line.symbol);
    if (!candidate) throw new ExecutionError("invalid_request", 400, `${line.symbol} isn't part of this thesis.`);
    return { ...line, companyName: candidate.companyName, universalSymbolId: candidate.universalSymbolId };
  });

  let account: PortfolioAccount | undefined;
  let quotes: SymbolsQuotesInner[];
  try {
    account = (await loadOverview(ctx)).accounts.find((candidate) => candidate.id === request.accountId);
    if (!account) throw new ExecutionError("account_not_found", 404, "That account isn't connected to SnapTrade.");
    const symbols = lines.filter((line) => line.units > 0).map((line) => line.symbol);
    if (symbols.length === 0) throw new ExecutionError("nothing_to_order", 422, "Every line has 0 shares.");
    quotes = await snapTradeQuoteSource(ctx, account).quotes(symbols);
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw quoteFailure(error);
  }

  const snapshot = await getDb().accountSnapshot.findUnique({
    where: { userId_accountId: { userId: ctx.userId, accountId: account.id } },
    select: { balances: true },
  });
  const now = deps.now?.() ?? new Date();
  return finishPreflight({
    request,
    now,
    owner: { userId: ctx.userId, guestKey: null, guestClient: null },
    thesisId: thesis.id,
    thesis: {
      title: thesis.title,
      summary: thesis.summary,
      riskProfile: thesis.riskProfile as RiskProfile,
    },
    account,
    accountKey: hashAccountId(ctx.config, account.id),
    input: {
      lines,
      quotes: quoteMap(quotes),
      market: marketFor(request.currency, now),
      budget: request.budget,
      currency: request.currency,
      account,
      cash: cashIn(snapshot?.balances as CashBalance[] | undefined, request.currency),
      liveTradingEnabled: serverEnv().LIVE_TRADING_ENABLED,
      guest: false,
      priceSource: "snaptrade",
    },
  });
}

/** Demo accounts are shared fixtures, so pacing and the one-active rule are per guest. */
export const demoAccountKey = (guestKey: string, accountId: string) =>
  `demo:${createHash("sha256").update(`${guestKey}:${accountId}`).digest("hex").slice(0, 32)}`;

/** Guest pre-flight: fixture account and fictional quotes, no SnapTrade calls. */
export async function preflightForGuest(
  guest: GuestIdentity,
  request: PreflightRequest,
  deps: { now?: () => Date } = {},
): Promise<PreflightPayload> {
  const account = demoOverview().accounts.find((candidate) => candidate.id === request.accountId);
  if (!account) throw new ExecutionError("account_not_found", 404, "That isn't one of the demo accounts.");
  const known = new Map(
    DEMO_QUOTES.quotes.flatMap((quote) => (quote.symbol ? [[quote.symbol.symbol.toUpperCase(), quote.symbol]] : [])),
  );
  const lines = request.lines.map((line) => {
    const symbol = known.get(line.symbol);
    if (!symbol || symbol.currency?.code !== request.currency) {
      throw new ExecutionError("invalid_request", 400, `${line.symbol} isn't in the demo's ${request.currency} price feed.`);
    }
    return { ...line, universalSymbolId: symbol.id };
  });

  const usage = await guestUsage(guest.guestClient);
  if (usage.preflights >= GUEST_PREFLIGHTS_PER_DAY) {
    throw new ExecutionError(
      "guest_limit",
      429,
      `The demo allows ${GUEST_PREFLIGHTS_PER_DAY} pre-flights per visitor per day. Try again tomorrow.`,
    );
  }

  const now = deps.now?.() ?? new Date();
  const quotes = await demoQuoteSource().quotes(lines.filter((line) => line.units > 0).map((line) => line.symbol));
  return finishPreflight({
    request,
    now,
    owner: { userId: null, ...guest },
    thesisId: null,
    thesis: request.thesis,
    account,
    accountKey: demoAccountKey(guest.guestKey, account.id),
    input: {
      lines,
      quotes: quoteMap(quotes),
      market: marketFor(request.currency, now),
      budget: request.budget,
      currency: request.currency,
      account,
      cash: cashIn(demoSnapshot(account.id)?.balances, request.currency),
      liveTradingEnabled: serverEnv().LIVE_TRADING_ENABLED,
      guest: true,
      priceSource: "demo",
    },
  });
}

export type CreateExecutionInput = {
  basketId: string;
  mode: "paper" | "live";
  simulateRejectSeq: number | null;
  idempotencyKey: string;
};

/**
 * Confirms a pre-flight. Live is refused in this release whatever the kill
 * switch says; Paper needs a pre-flight from the last five minutes.
 */
export async function createExecution(
  actor: Actor,
  input: CreateExecutionInput,
  deps: { now?: () => Date } = {},
): Promise<{ execution: ExecutionView; created: boolean }> {
  const basket = await findOwnedBasket(input.basketId, actor);
  if (!basket) throw new ExecutionError("not_found", 404, "Basket not found.");
  const guest = basket.userId == null;

  if (input.mode === "live") {
    throw serverEnv().LIVE_TRADING_ENABLED
      ? new ExecutionError("live_unavailable", 501, "Live order submission ships in a later release. Use Paper.")
      : new ExecutionError("live_disabled", 403, "Live trading is switched off on this deployment. Use Paper.");
  }

  const preflight = basket.preflight as unknown as PreflightPayload;
  if (input.simulateRejectSeq != null && input.simulateRejectSeq > preflight.orders.length) {
    throw new ExecutionError("invalid_request", 400, "There's no leg with that number to reject.");
  }
  const now = deps.now?.() ?? new Date();
  if (basket.status === "draft" && now.getTime() - basket.preflightAt.getTime() > PREFLIGHT_TTL_MS) {
    throw new ExecutionError("preflight_stale", 409, "These prices are more than 5 minutes old. Refresh pre-flight.");
  }

  if (guest && basket.guestClient && basket.status === "draft") {
    const usage = await guestUsage(basket.guestClient);
    if (usage.runs >= GUEST_PAPER_RUNS_PER_DAY || usage.allRuns >= GUEST_PAPER_RUNS_GLOBAL_PER_DAY) {
      throw new ExecutionError("guest_limit", 429, "The demo's paper runs for today are used up. Try again tomorrow.");
    }
  }

  const { executionId, created } = await insertExecution({
    basketId: basket.id,
    accountKey: basket.accountKey,
    mode: input.mode,
    idempotencyKey: input.idempotencyKey,
    confirmation: {
      mode: input.mode,
      confirmedAt: now.toISOString(),
      preparedAt: preflight.preparedAt,
      orders: preflight.orders,
      totals: preflight.totals,
      market: preflight.market,
      priceSource: preflight.priceSource,
      impactNote: preflight.impactNote,
      disclosures: preflight.disclosures[input.mode],
      simulateRejectSeq: input.simulateRejectSeq,
    } as unknown as Prisma.InputJsonObject,
    simulateRejectSeq: input.simulateRejectSeq,
    orders: preflight.orders,
  });
  if (created) {
    await recordEvent(
      "execution_confirmed",
      {
        executionId,
        basketId: basket.id,
        mode: input.mode,
        kind: "deploy",
        orders: preflight.orders.length,
        marketOpen: preflight.market.open,
        simulateReject: input.simulateRejectSeq != null,
        guest,
      },
      basket.userId ?? undefined,
    );
  }
  return { execution: await loadExecutionView(executionId), created };
}

export async function requireExecution(actor: Actor, executionId: string) {
  const owned = await findExecutionForActor(executionId, actor);
  if (!owned) throw new ExecutionError("not_found", 404, "Execution not found.");
  return owned;
}

export async function retryLeg(actor: Actor, executionId: string, legId: string): Promise<ExecutionView> {
  await requireExecution(actor, executionId);
  await queueRetry(executionId, legId);
  return loadExecutionView(executionId);
}

export async function cancelExecution(actor: Actor, executionId: string): Promise<ExecutionView> {
  const owned = await requireExecution(actor, executionId);
  const skipped = await cancelPending(executionId);
  if (skipped > 0) {
    await recordEvent(
      "execution_canceled",
      { executionId, mode: owned.view.mode, skipped, guest: owned.userId == null },
      owned.userId ?? undefined,
    );
  }
  return loadExecutionView(executionId);
}
