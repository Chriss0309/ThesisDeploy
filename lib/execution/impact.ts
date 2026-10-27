import type { ManualTradeAndImpact } from "snaptrade-typescript-sdk";

import { getDb } from "@/lib/db/client";
import { liveTradingEnabled } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { ExecutionError, findOwnedBasket, reservePacingSlot, type Actor } from "@/lib/execution/store";
import {
  PACE_MS,
  PREFLIGHT_TTL_MS,
  type ExecutionKind,
  type ImpactCheck,
  type ImpactLeg,
  type PreflightPayload,
} from "@/lib/execution/types";
import type { Prisma } from "@/lib/generated/prisma/client";
import { SnapTradeError, callSnapTrade, snapTradeContext, type SnapTradeContext } from "@/lib/snaptrade/client";
import { recordEvent } from "@/lib/telemetry/events";

/** SnapTrade doesn't document how an unsupported preview fails; these are the shapes seen across brokers. */
const UNSUPPORTED_STATUS = new Set([404, 405, 501]);
const UNSUPPORTED_DETAIL = /not\s+(yet\s+)?supported|unsupported|not\s+available|isn'?t\s+supported/i;

export type ImpactDeps = { ctx?: SnapTradeContext; now?: () => Date; paceMs?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function paced(accountKey: string, paceMs: number) {
  for (let wait = await reservePacingSlot(accountKey, paceMs); wait > 0; wait = await reservePacingSlot(accountKey, paceMs)) {
    await sleep(wait);
  }
}

const money = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Asks the broker to preview every leg with SnapTrade's order impact, one per
 * 1.1 seconds on the account's trade pacing (impact isn't account-limited).
 * Nothing is placed. A broker that has no preview leaves Live available with
 * the impact labeled "not available"; a broker that refuses a leg blocks Live
 * with its reason. The result is saved on the pre-flight being confirmed.
 */
export async function checkImpact(
  actor: Actor,
  basketId: string,
  request: { kind: ExecutionKind; preflightId?: string | null },
  deps: ImpactDeps = {},
): Promise<PreflightPayload> {
  const basket = await findOwnedBasket(basketId, actor);
  if (!basket) throw new ExecutionError("not_found", 404, "Basket not found.");
  if (!basket.userId || basket.userId !== actor.userId) {
    throw new ExecutionError("live_signed_in_only", 403, "Brokerage previews need your own SnapTrade account. Sign in first.");
  }
  if (!liveTradingEnabled()) throw new ExecutionError("live_disabled", 403, "Live trading is switched off on this deployment.");

  const action = request.kind !== "deploy";
  const preflight = (action ? basket.actionPreflight : basket.preflight) as unknown as PreflightPayload | null;
  if (
    !preflight ||
    (action && (preflight.kind !== request.kind || preflight.preflightId !== request.preflightId)) ||
    (!action && basket.status !== "draft")
  ) {
    throw new ExecutionError("preflight_stale", 409, "This pre-flight was replaced. Run pre-flight again.");
  }
  const now = deps.now?.() ?? new Date();
  if (now.getTime() - Date.parse(preflight.preparedAt) > PREFLIGHT_TTL_MS) {
    throw new ExecutionError("preflight_stale", 409, "These prices are more than 5 minutes old. Refresh pre-flight.");
  }
  if (!preflight.live.available) {
    throw new ExecutionError("live_unavailable", 409, preflight.live.reasons[0] ?? "Live isn't available for this pre-flight.");
  }

  const ctx = deps.ctx ?? snapTradeContext(basket.userId);
  const institution = basket.institution;
  const legs: ImpactLeg[] = [];
  let unsupported = false;
  const startedAt = performance.now();
  for (const order of preflight.orders) {
    const empty = { seq: order.seq, estimatedCommission: null, forexFees: null, remainingCash: null };
    if (unsupported) {
      legs.push({ ...empty, status: "unavailable", message: `${institution} doesn't offer order previews.` });
      continue;
    }
    if (!order.universalSymbolId) {
      legs.push({ ...empty, status: "unavailable", message: "No SnapTrade symbol ID to preview with." });
      continue;
    }
    await paced(basket.accountKey, deps.paceMs ?? PACE_MS);
    try {
      const result: ManualTradeAndImpact = await callSnapTrade(
        ctx,
        "getOrderImpact",
        (api) =>
          api.trading.getOrderImpact({
            account_id: basket.accountId,
            action: order.action,
            universal_symbol_id: order.universalSymbolId!,
            order_type: "Market",
            time_in_force: "Day",
            units: order.units,
          }),
        { brokerageSlug: basket.brokerageSlug },
      );
      const impact = result.trade_impacts?.[0];
      legs.push({
        ...empty,
        status: "ok",
        estimatedCommission: money(impact?.estimated_commission),
        forexFees: money(impact?.forex_fees),
        remainingCash: money(impact?.remaining_cash),
        message: null,
      });
    } catch (error) {
      if (!(error instanceof SnapTradeError)) throw error;
      if (error.code === "rate_limited") {
        throw new ExecutionError("rate_limited", 429, "SnapTrade asked to slow down. Try the preview again shortly.", {
          retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterSeconds ?? 5)),
        });
      }
      const status = error.status ?? 0;
      if (error.code === "upstream" && (UNSUPPORTED_STATUS.has(status) || UNSUPPORTED_DETAIL.test(error.detail ?? ""))) {
        unsupported = true;
        legs.push({ ...empty, status: "unavailable", message: `${institution} doesn't offer order previews.` });
      } else if (error.code === "upstream" && status >= 400 && status < 500) {
        legs.push({ ...empty, status: "rejected", message: error.detail ?? `HTTP ${status}` });
      } else {
        console.error("[impact] preview failed", describeError(error));
        legs.push({ ...empty, status: "unavailable", message: "SnapTrade couldn't preview this leg." });
      }
    }
  }

  const ok = legs.filter((leg) => leg.status === "ok");
  const complete = ok.length === legs.length;
  const sum = (pick: (leg: ImpactLeg) => number | null) =>
    complete && ok.every((leg) => pick(leg) != null) ? ok.reduce((total, leg) => total + (pick(leg) ?? 0), 0) : null;
  const impact: ImpactCheck = {
    source: unsupported ? "unsupported" : legs.some((leg) => leg.status !== "ok") ? "unavailable" : "brokerage",
    checkedAt: now.toISOString(),
    legs,
    totalCommission: sum((leg) => leg.estimatedCommission),
    totalForexFees: sum((leg) => leg.forexFees),
    remainingCash: ok.at(-1)?.remainingCash ?? null,
  };
  const rejections = legs
    .filter((leg) => leg.status === "rejected")
    .map((leg) => `${institution} rejected the preview of leg ${leg.seq}: ${leg.message ?? "no reason given"}.`);
  const updated: PreflightPayload = {
    ...preflight,
    basketId: basket.id,
    impact,
    live: { ...preflight.live, available: rejections.length === 0, reasons: [...preflight.live.reasons, ...rejections] },
  };
  await getDb().basket.update({
    where: { id: basket.id },
    data: action
      ? { actionPreflight: updated as unknown as Prisma.InputJsonObject }
      : { preflight: updated as unknown as Prisma.InputJsonObject },
  });
  await recordEvent(
    "impact_checked",
    {
      basketId: basket.id,
      kind: request.kind,
      brokerage: basket.brokerageSlug,
      legs: legs.length,
      source: impact.source,
      rejected: rejections.length,
      latencyMs: Math.round(performance.now() - startedAt),
    },
    basket.userId,
  );
  return updated;
}
