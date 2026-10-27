import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db/client";
import { serverEnv } from "@/lib/env";
import {
  ExecutionError,
  basketPath,
  findActiveExecutionId,
  listBaskets,
  ownedBy,
  type Actor,
  type BasketRow,
} from "@/lib/execution/store";
import type { PreflightPayload } from "@/lib/execution/types";
import { PREFLIGHT_TTL_MS, type ExecutionView } from "@/lib/execution/types";
import { Prisma } from "@/lib/generated/prisma/client";
import { marketForCurrency, marketStatus } from "@/lib/market-hours";
import { snapTradeContext, type SnapTradeContext } from "@/lib/snaptrade/client";
import { recordEvent } from "@/lib/telemetry/events";
import { ActionPlanError, buildActionPreflight } from "@/lib/theses/action-preflight";
import {
  demoMarks,
  fetchQuotes,
  marksForBaskets,
  marksFromQuotes,
  quoteProblem,
  saveMarks,
  simulatedMovesOf,
  storedMarks,
} from "@/lib/theses/marks";
import type { Marks, ThesisCard } from "@/lib/theses/types";
import { valueBasket } from "@/lib/theses/valuation";
import type { RiskProfile } from "@/lib/thesis/schema";

const isGuestBasket = (row: Pick<BasketRow, "userId">) => row.userId == null;

/** The latest rebalance or close run shows on its card until it settles cleanly. */
function visibleExecution(execution: ExecutionView | null): ExecutionView | null {
  if (!execution || execution.kind === "deploy") return null;
  return execution.status === "completed" || execution.status === "canceled" ? null : execution;
}

export type ThesesPage = { cards: ThesisCard[] };

/** Every saved basket for the actor, valued at current prices. Signed-in baskets need `ctx` for quotes. */
export async function loadTheses(
  actor: Actor,
  { ctx, now = new Date() }: { ctx?: SnapTradeContext; now?: Date } = {},
): Promise<ThesesPage> {
  const listed = await listBaskets(actor);
  const signedIn = listed.map((entry) => entry.row).filter((row) => !isGuestBasket(row) && row.status !== "closed");
  const live = ctx ? await marksForBaskets(ctx, signedIn, now) : new Map();

  const cards = listed.map(({ row, execution }): ThesisCard => {
    const guest = isGuestBasket(row);
    const moves = guest ? simulatedMovesOf(row) : null;
    const symbols = row.constituents.map((c) => c.symbol);
    const result = guest
      ? { marks: demoMarks(moves, symbols), stale: false, problem: null as string | null }
      : (live.get(row.id) ?? { marks: storedMarks(row), stale: false, problem: null as string | null });
    const closed = row.status === "closed";
    const valuation =
      row.status === "deploying" && !row.constituents.some((c) => c.ledgerUnits > 0)
        ? null
        : valueBasket({
            constituents: row.constituents.map((c) => ({
              symbol: c.symbol,
              companyName: c.companyName,
              targetWeight: c.targetWeight,
              ledgerUnits: c.ledgerUnits,
              costTotal: c.costTotal.toNumber(),
              realizedTotal: c.realizedTotal.toNumber(),
            })),
            marks: result.marks,
            cash: row.cash.toNumber(),
            contributed: row.contributed.toNumber(),
          });
    const source = result.marks?.source ?? (guest ? "demo" : "snaptrade");
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      riskProfile: row.riskProfile as RiskProfile,
      status: row.status as ThesisCard["status"],
      currency: row.currency,
      accountName: row.accountName,
      institution: row.institution,
      deployedAt: row.deployedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      mode: row.mode as ThesisCard["mode"],
      budget: row.budget.toNumber(),
      contributed: row.contributed.toNumber(),
      valuation,
      pricing: {
        source,
        asOf: closed ? null : (result.marks?.asOf ?? null),
        stale: result.stale,
        problem: valuation || closed ? result.problem : (result.problem ?? "No prices yet for this basket."),
      },
      execution: visibleExecution(execution),
      simulatedMoves: moves,
      basketPath: basketPath(row),
    };
  });
  return { cards };
}

/** Telemetry for the dashboard being opened with at least one priced, active basket. */
export async function recordDriftViewed(cards: readonly ThesisCard[], userId: string | null): Promise<void> {
  const priced = cards.filter((card) => card.status === "active" && card.valuation);
  if (priced.length === 0) return;
  const maxAbsDrift = Math.max(...priced.map((card) => card.valuation!.maxAbsDrift));
  await recordEvent(
    "drift_viewed",
    {
      baskets: priced.length,
      flagged: priced.filter((card) => card.valuation!.rebalanceRecommended).length,
      maxAbsDriftPoints: Math.round(maxAbsDrift * 1000) / 10,
      guest: userId == null,
    },
    userId ?? undefined,
  );
}

async function requireActionBasket(actor: Actor, basketId: string): Promise<BasketRow> {
  const row = await getDb().basket.findFirst({
    where: { id: basketId, ...ownedBy(actor) },
    include: { constituents: true },
  });
  if (!row) throw new ExecutionError("not_found", 404, "Basket not found.");
  if (row.status !== "active") {
    throw new ExecutionError(
      "not_active",
      409,
      row.status === "closed" ? "This basket is closed." : "Only an active basket can be rebalanced or closed.",
    );
  }
  if (row.mode === "live") {
    throw new ExecutionError("live_unavailable", 501, "Live baskets can't be rebalanced or closed in this release.");
  }
  const active = await findActiveExecutionId(row.id);
  if (active) {
    throw new ExecutionError("execution_active", 409, "This basket still has an execution running. Finish or cancel it first.", {
      executionId: active,
    });
  }
  return row;
}

export type ActionPreflightDeps = { now?: () => Date; ctx?: SnapTradeContext };

/**
 * Pre-flight for a rebalance or a close. Prices come from one fresh quotes
 * call (signed in) or the demo feed, the plan from the basket ledger. The
 * result is saved on the basket under a new id that can be confirmed once.
 */
export async function actionPreflight(
  actor: Actor,
  basketId: string,
  kind: "rebalance" | "close",
  deps: ActionPreflightDeps = {},
): Promise<PreflightPayload> {
  const row = await requireActionBasket(actor, basketId);
  const guest = isGuestBasket(row);
  const now = deps.now?.() ?? new Date();
  const symbols = row.constituents.map((c) => c.symbol);

  let marks: Marks;
  if (guest) {
    marks = demoMarks(simulatedMovesOf(row), symbols);
  } else {
    const ctx = deps.ctx ?? (actor.userId ? snapTradeContext(actor.userId) : null);
    if (!ctx) throw new ExecutionError("signed_out", 401, "Sign in with SnapTrade to continue.");
    try {
      marks = marksFromQuotes(await fetchQuotes(ctx, { id: row.accountId, brokerageSlug: row.brokerageSlug }, symbols), now, "snaptrade");
    } catch (error) {
      const problem = quoteProblem(error);
      const limited = problem.includes("request limit");
      throw new ExecutionError(limited ? "rate_limited" : "snaptrade_unavailable", limited ? 429 : 502, problem);
    }
    await saveMarks(row.id, marks, now);
  }

  const stored = row.preflight as unknown as PreflightPayload;
  const market = marketStatus(marketForCurrency(row.currency) ?? "NYSE", now);
  let built;
  try {
    built = buildActionPreflight({
      kind,
      currency: row.currency,
      account: {
        id: row.accountId,
        name: row.accountName,
        institution: row.institution,
        isPaper: stored.account?.isPaper ?? false,
      },
      constituents: row.constituents.map((c) => ({
        symbol: c.symbol,
        companyName: c.companyName,
        universalSymbolId: c.universalSymbolId,
        targetWeight: c.targetWeight,
        ledgerUnits: c.ledgerUnits,
        costTotal: c.costTotal.toNumber(),
        realizedTotal: c.realizedTotal.toNumber(),
      })),
      marks,
      market,
      guest,
      liveTradingEnabled: serverEnv().LIVE_TRADING_ENABLED,
    });
  } catch (error) {
    if (error instanceof ActionPlanError) {
      throw new ExecutionError(error.code, error.code === "price_unavailable" ? 502 : 422, error.message);
    }
    throw error;
  }

  const payload: PreflightPayload = {
    ...built,
    preflightId: randomUUID(),
    basketId: row.id,
    title: row.title,
    preparedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PREFLIGHT_TTL_MS).toISOString(),
  };
  await getDb().basket.update({
    where: { id: row.id },
    data: { actionPreflight: payload as unknown as Prisma.InputJsonObject },
  });
  await recordEvent(
    "preflight_opened",
    {
      basketId: row.id,
      kind,
      guest,
      orders: payload.orders.length,
      currency: row.currency,
      marketOpen: payload.market.open,
      liveAvailable: false,
    },
    row.userId ?? undefined,
  );
  return payload;
}

/** The demo's reviewer tool: scales one stock's fictional price so drift can be shown without waiting for a market. */
export async function simulateMove(
  actor: Actor,
  basketId: string,
  input: { reset: true } | { symbol: string; change: number },
): Promise<Record<string, number> | null> {
  if (!actor.guestKey) throw new ExecutionError("not_found", 404, "Basket not found.");
  const row = await getDb().basket.findFirst({
    where: { id: basketId, userId: null, guestKey: actor.guestKey },
    include: { constituents: true },
  });
  if (!row) throw new ExecutionError("not_found", 404, "Basket not found.");
  if (row.status !== "active") throw new ExecutionError("not_active", 409, "Only an active basket can be repriced.");
  let moves: Record<string, number> | null = null;
  if (!("reset" in input)) {
    const symbol = input.symbol.toUpperCase();
    if (!row.constituents.some((c) => c.symbol === symbol)) {
      throw new ExecutionError("invalid_request", 400, `${symbol} isn't in this basket.`);
    }
    if (!Number.isFinite(input.change) || input.change < -0.9 || input.change > 2) {
      throw new ExecutionError("invalid_request", 400, "Pick a price move between −90% and +200%.");
    }
    moves = { ...(simulatedMovesOf(row) ?? {}), [symbol]: Math.round((1 + input.change) * 10_000) / 10_000 };
  }
  await getDb().basket.update({ where: { id: row.id }, data: { simulatedMoves: moves ?? Prisma.DbNull } });
  return moves;
}
