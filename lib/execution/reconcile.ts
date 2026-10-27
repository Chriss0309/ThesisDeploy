import type { AccountOrderRecord } from "snaptrade-typescript-sdk";

import { getDb } from "@/lib/db/client";
import { describeError } from "@/lib/errors";
import { recordSettlement } from "@/lib/execution/drain";
import { orderOutcome } from "@/lib/execution/live-orders";
import {
  ExecutionError,
  claimReconcile,
  finalizeExecution,
  loadExecutionView,
  openLiveLegs,
  recordOpenLegResult,
  type Actor,
} from "@/lib/execution/store";
import { requireExecution } from "@/lib/execution/service";
import { RECONCILE_INTERVAL_MS, type ExecutionView } from "@/lib/execution/types";
import type { ExecutionLeg } from "@/lib/generated/prisma/client";
import { SnapTradeError, callSnapTrade, snapTradeContext, type SnapTradeContext } from "@/lib/snaptrade/client";
import { recordEvent } from "@/lib/telemetry/events";

/** Brokers without recent orders answer with these; order detail is the fallback, a few legs per pass. */
const NO_RECENT_ORDERS = new Set([404, 405, 501]);
const MAX_DETAIL_CALLS = 3;
/** An `unknown` order is matched only if the broker timestamped it no earlier than this before the claim. */
const CLOCK_SKEW_MS = 60_000;

export type ReconcileResult = { execution: ExecutionView; checked: boolean; nextCheckAt: string | null };

const sameSymbol = (record: AccountOrderRecord, symbol: string) => {
  const target = symbol.toUpperCase();
  const universal = record.universal_symbol as { symbol?: string; raw_symbol?: string } | null | undefined;
  return universal?.symbol?.toUpperCase() === target || universal?.raw_symbol?.toUpperCase() === target;
};

/** The broker's record for an unconfirmed leg: same symbol, side, and quantity, placed after the leg was claimed. */
export function matchUnknown(
  leg: Pick<ExecutionLeg, "symbol" | "action" | "units" | "claimedAt">,
  records: readonly AccountOrderRecord[],
  taken: ReadonlySet<string>,
): AccountOrderRecord | null {
  const since = (leg.claimedAt?.getTime() ?? 0) - CLOCK_SKEW_MS;
  const candidates = records
    .filter(
      (record) =>
        record.brokerage_order_id &&
        !taken.has(record.brokerage_order_id) &&
        sameSymbol(record, leg.symbol) &&
        String(record.action ?? "").toUpperCase() === leg.action &&
        Number(record.total_quantity) === leg.units &&
        Date.parse(record.time_placed ?? "") >= since,
    )
    .sort((a, b) => Date.parse(a.time_placed ?? "") - Date.parse(b.time_placed ?? ""));
  return candidates[0] ?? null;
}

async function fetchOrders(
  ctx: SnapTradeContext,
  account: { accountId: string; brokerageSlug: string | null },
  legs: readonly ExecutionLeg[],
): Promise<AccountOrderRecord[]> {
  try {
    const recent = await callSnapTrade(
      ctx,
      "getUserAccountRecentOrders",
      (api) => api.accounts.getUserAccountRecentOrders({ accountId: account.accountId, onlyExecuted: false }),
      { accountId: account.accountId, brokerageSlug: account.brokerageSlug },
    );
    return recent.orders ?? [];
  } catch (error) {
    if (!(error instanceof SnapTradeError) || error.code !== "upstream" || !NO_RECENT_ORDERS.has(error.status ?? 0)) {
      throw error;
    }
  }
  const records: AccountOrderRecord[] = [];
  for (const leg of legs.filter((candidate) => candidate.brokerageOrderId).slice(0, MAX_DETAIL_CALLS)) {
    records.push(
      await callSnapTrade(
        ctx,
        "getUserAccountOrderDetail",
        (api) =>
          api.accounts.getUserAccountOrderDetail({ accountId: account.accountId, brokerage_order_id: leg.brokerageOrderId! }),
        { accountId: account.accountId, brokerageSlug: account.brokerageSlug },
      ),
    );
  }
  return records;
}

const time = (date: Date) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(date);

/**
 * Brings open Live legs up to date with the broker: one recent-orders call
 * (account-limited) at most every 15 seconds per execution, shared across
 * tabs. Accepted legs are matched by broker order ID; an `unknown` leg by
 * symbol, side, quantity, and time. Fills reach the ledger once, by delta.
 */
export async function reconcileExecution(
  actor: Actor,
  executionId: string,
  deps: { ctx?: SnapTradeContext; now?: () => Date } = {},
): Promise<ReconcileResult> {
  const owned = await requireExecution(actor, executionId);
  if (owned.view.mode !== "live" || !owned.userId) {
    throw new ExecutionError("not_live", 400, "Only Live executions have orders to check at the broker.");
  }
  const open = await openLiveLegs(executionId);
  if (open.length === 0) {
    const finalized = await finalizeExecution(executionId);
    const execution = await loadExecutionView(executionId);
    await recordSettlement(finalized, execution, owned.userId);
    return { execution, checked: false, nextCheckAt: null };
  }
  const slot = await claimReconcile(executionId, RECONCILE_INTERVAL_MS);
  if (!slot.ok) return { execution: owned.view, checked: false, nextCheckAt: slot.nextAt.toISOString() };

  const ctx = deps.ctx ?? snapTradeContext(owned.userId);
  const now = deps.now?.() ?? new Date();
  const institution = owned.view.institution;
  let records: AccountOrderRecord[];
  try {
    records = await fetchOrders(ctx, owned, open);
  } catch (error) {
    if (error instanceof SnapTradeError && (error.code === "rate_limited" || error.code === "budget_exhausted")) {
      const wait = Math.max(RECONCILE_INTERVAL_MS, (error.retryAfterSeconds ?? 15) * 1000);
      return { execution: owned.view, checked: false, nextCheckAt: new Date(now.getTime() + wait).toISOString() };
    }
    if (error instanceof SnapTradeError) {
      console.error("[reconcile] order status unavailable", describeError(error));
      throw new ExecutionError("snaptrade_unavailable", 502, `SnapTrade couldn't read ${institution}'s orders. Try again shortly.`);
    }
    throw error;
  }

  const byId = new Map(records.flatMap((record) => (record.brokerage_order_id ? [[record.brokerage_order_id, record]] : [])));
  const all = await getDb().executionLeg.findMany({ where: { executionId }, select: { brokerageOrderId: true } });
  const taken = new Set(all.flatMap((leg) => (leg.brokerageOrderId ? [leg.brokerageOrderId] : [])));
  for (const leg of open) {
    const record = leg.brokerageOrderId ? byId.get(leg.brokerageOrderId) : matchUnknown(leg, records, taken);
    if (!record) {
      if (leg.status === "unknown") {
        await getDb().executionLeg.update({
          where: { id: leg.id },
          data: {
            errorMessage: `Not in ${institution}'s orders from the last 24 hours as of ${time(now)} ET. If it isn't in your ${institution} account either, confirm and retry it.`,
          },
        });
      }
      continue;
    }
    if (record.brokerage_order_id) taken.add(record.brokerage_order_id);
    const outcome = orderOutcome(record, { units: leg.units, estPrice: leg.estPrice.toNumber() }, {
      institution,
      final: true,
      latencyMs: leg.latencyMs ?? 0,
      requestId: leg.requestId,
    });
    const unchanged =
      outcome.kind === "working" &&
      leg.status !== "unknown" &&
      outcome.snaptradeStatus === leg.snaptradeStatus &&
      outcome.filledUnits === (leg.filledUnits ?? 0);
    if (unchanged) continue;
    const recorded = await recordOpenLegResult(leg, owned.view.basketId, outcome);
    await recordEvent(
      "leg_result",
      {
        executionId,
        mode: "live",
        status: recorded.status,
        attempt: recorded.attempt,
        brokerage: owned.brokerageSlug,
        errorCode: recorded.errorCode,
        source: "reconcile",
        guest: false,
      },
      owned.userId,
    );
  }

  const finalized = await finalizeExecution(executionId);
  const execution = await loadExecutionView(executionId);
  await recordSettlement(finalized, execution, owned.userId);
  return { execution, checked: true, nextCheckAt: new Date(now.getTime() + RECONCILE_INTERVAL_MS).toISOString() };
}
