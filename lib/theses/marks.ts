import type { SymbolsQuotesInner } from "snaptrade-typescript-sdk";

import { getDb } from "@/lib/db/client";
import { describeError } from "@/lib/errors";
import { ReauthRequiredError } from "@/lib/auth/vault";
import type { BasketRow } from "@/lib/execution/store";
import type { Prisma } from "@/lib/generated/prisma/client";
import { SnapTradeError, callSnapTrade, type SnapTradeContext } from "@/lib/snaptrade/client";
import type { Marks, PriceMark } from "@/lib/theses/types";
import { DEMO_QUOTES } from "@/lib/thesis/quote-sources";

/** A basket's cached prices are reused for this long, so a busy dashboard stays inside the account's 10 requests a minute. */
export const MARKS_TTL_MS = 60_000;
/** SnapTrade quotes accept up to 10 symbols per request. */
const QUOTE_BATCH = 10;

export function marksFromQuotes(quotes: readonly SymbolsQuotesInner[], asOf: Date, source: Marks["source"]): Marks {
  const prices: Record<string, PriceMark> = {};
  for (const quote of quotes) {
    if (!quote.symbol) continue;
    prices[quote.symbol.symbol.toUpperCase()] = {
      last: quote.last_trade_price ?? null,
      bid: quote.bid_price ?? null,
      ask: quote.ask_price ?? null,
    };
  }
  return { source, asOf: asOf.toISOString(), prices };
}

/** Fictional demo prices, scaled by the guest's "Simulate a market move" multipliers. */
export function demoMarks(simulatedMoves: Record<string, number> | null, symbols: readonly string[]): Marks {
  const wanted = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  const base = marksFromQuotes(
    DEMO_QUOTES.quotes.filter((quote) => quote.symbol && wanted.has(quote.symbol.symbol.toUpperCase())),
    new Date(DEMO_QUOTES.as_of),
    "demo",
  );
  for (const [symbol, factor] of Object.entries(simulatedMoves ?? {})) {
    const mark = base.prices[symbol];
    if (!mark || !Number.isFinite(factor) || factor <= 0) continue;
    const scale = (price: number | null) => (price == null ? null : Math.round(price * factor * 100) / 100);
    base.prices[symbol] = { last: scale(mark.last), bid: scale(mark.bid), ask: scale(mark.ask) };
  }
  return base;
}

export function storedMarks(row: Pick<BasketRow, "marks" | "markedAt">): Marks | null {
  const marks = row.marks as Marks | null;
  return marks && typeof marks === "object" && marks.prices ? marks : null;
}

export function simulatedMovesOf(row: Pick<BasketRow, "simulatedMoves">): Record<string, number> | null {
  const moves = row.simulatedMoves as Record<string, number> | null;
  return moves && typeof moves === "object" ? moves : null;
}

export function quoteProblem(error: unknown): string {
  if (error instanceof SnapTradeError && (error.code === "rate_limited" || error.code === "budget_exhausted")) {
    const wait = Math.max(1, Math.ceil(error.retryAfterSeconds ?? 60));
    return `This account's SnapTrade request limit (10 per minute) is used up. Prices refresh in about ${wait} seconds.`;
  }
  console.error("[theses] quotes failed", describeError(error));
  return "SnapTrade couldn't price this basket right now.";
}

/** One batched quotes call per ten symbols; every call is account-scoped and budget-checked. */
export async function fetchQuotes(
  ctx: SnapTradeContext,
  account: { id: string; brokerageSlug: string | null },
  symbols: readonly string[],
): Promise<SymbolsQuotesInner[]> {
  const unique = [...new Set(symbols)];
  const quotes: SymbolsQuotesInner[] = [];
  for (let i = 0; i < unique.length; i += QUOTE_BATCH) {
    const batch = unique.slice(i, i + QUOTE_BATCH);
    quotes.push(
      ...(await callSnapTrade(
        ctx,
        "getUserAccountQuotes",
        (api) => api.trading.getUserAccountQuotes({ accountId: account.id, symbols: batch.join(","), useTicker: true }),
        { accountId: account.id, brokerageSlug: account.brokerageSlug },
      )),
    );
  }
  return quotes;
}

export async function saveMarks(basketId: string, marks: Marks, at: Date): Promise<void> {
  await getDb().basket.update({
    where: { id: basketId },
    data: { marks: marks as unknown as Prisma.InputJsonObject, markedAt: at },
  });
}

export type MarkResult = { marks: Marks | null; stale: boolean; problem: string | null };

/**
 * Prices for each basket, one quotes call per account for the baskets whose
 * cached prices are older than the TTL. A failed refresh falls back to the
 * cached prices and says so; it never invents a price.
 */
export async function marksForBaskets(
  ctx: SnapTradeContext,
  rows: readonly BasketRow[],
  now: Date,
): Promise<Map<string, MarkResult>> {
  const results = new Map<string, MarkResult>();
  const byAccount = new Map<string, BasketRow[]>();
  for (const row of rows) {
    const cached = storedMarks(row);
    const held = row.constituents.some((c) => c.ledgerUnits > 0);
    const fresh = cached && row.markedAt && now.getTime() - row.markedAt.getTime() < MARKS_TTL_MS;
    if (!held || fresh) {
      results.set(row.id, { marks: cached, stale: false, problem: null });
      continue;
    }
    byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);
  }

  await Promise.all(
    [...byAccount.values()].map(async (group) => {
      const symbols = group.flatMap((row) => row.constituents.map((c) => c.symbol));
      try {
        const quotes = await fetchQuotes(ctx, { id: group[0].accountId, brokerageSlug: group[0].brokerageSlug }, symbols);
        const marks = marksFromQuotes(quotes, now, "snaptrade");
        await Promise.all(
          group.map(async (row) => {
            await saveMarks(row.id, marks, now);
            results.set(row.id, { marks, stale: false, problem: null });
          }),
        );
      } catch (error) {
        if (error instanceof ReauthRequiredError) throw error;
        const problem = quoteProblem(error);
        for (const row of group) results.set(row.id, { marks: storedMarks(row), stale: true, problem });
      }
    }),
  );
  return results;
}
