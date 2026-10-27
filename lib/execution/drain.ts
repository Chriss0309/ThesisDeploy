import { describeError } from "@/lib/errors";
import {
  claimNextLeg,
  finalizeExecution,
  loadExecutionView,
  markRunning,
  nextPendingWaitMs,
  recordLegResult,
  recoverStaleClaims,
  reservePacingSlot,
  toLegView,
  type Finalized,
  type OwnedExecution,
} from "@/lib/execution/store";
import { liveUnavailable, paperSubmitter, type SubmitResult, type Submitter } from "@/lib/execution/submitters";
import { summarizeLegs } from "@/lib/execution/summary";
import { PACE_MS, type DrainEvent, type ExecutionView } from "@/lib/execution/types";
import type { ExecutionLeg } from "@/lib/generated/prisma/client";
import { recordEvent, type EventOwner } from "@/lib/telemetry/events";

/** Leaves headroom under the drain route's 60-second maxDuration. */
export const DRAIN_BUDGET_MS = 45_000;

export type DrainOptions = {
  paceMs?: number;
  budgetMs?: number;
  /** Set when the client disconnects: no new leg is claimed, so nothing runs unattended. */
  signal?: AbortSignal;
  /** Places Live legs (lib/execution/live-orders.ts); without it, Live legs fail without being sent. */
  live?: Submitter;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Submits pending legs in order, at most one per `paceMs` per account, until
 * none is pending, the time budget runs out, or the client goes away. Failed
 * legs are recorded and the queue moves on. Safe to run concurrently and to
 * re-run: only pending legs can be claimed, and each claim is exclusive.
 */
export async function* drainExecution(owned: OwnedExecution, options: DrainOptions = {}): AsyncGenerator<DrainEvent> {
  const { view, accountKey } = owned;
  const paceMs = options.paceMs ?? PACE_MS;
  const budgetMs = options.budgetMs ?? DRAIN_BUDGET_MS;
  const { signal } = options;
  const startedAt = Date.now();
  const owner = { userId: owned.userId, guestKey: owned.guestKey };
  const submit: Submitter =
    view.mode === "paper"
      ? paperSubmitter({ simulateRejectSeq: view.simulateRejectSeq })
      : (options.live ?? liveUnavailable);

  let reason: Extract<DrainEvent, { type: "done" }>["reason"] = "finished";
  if (view.status === "queued" || view.status === "running") {
    await recoverStaleClaims(view.id);
    await markRunning(view.id);

    for (;;) {
      if (signal?.aborted) {
        reason = "aborted";
        break;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= budgetMs) {
        reason = "time_budget";
        break;
      }
      const wait = await nextPendingWaitMs(view.id);
      if (wait == null) break;
      if (wait > 0) {
        if (elapsed + wait >= budgetMs) {
          reason = "waiting";
          break;
        }
        await sleep(wait, signal);
        continue;
      }

      const pacing = await reservePacingSlot(accountKey, paceMs);
      if (pacing > 0) {
        yield { type: "pacing", waitMs: pacing };
        await sleep(pacing, signal);
        continue;
      }
      const leg = await claimNextLeg(view.id);
      if (!leg) continue;
      yield { type: "leg", leg: toLegView(leg) };

      let result: SubmitResult;
      try {
        result = await submit({
          seq: leg.seq,
          attempt: leg.attempt,
          action: leg.action as "BUY" | "SELL",
          symbol: leg.symbol,
          units: leg.units,
          estPrice: leg.estPrice.toNumber(),
          clientOrderId: leg.clientOrderId,
        });
      } catch (error) {
        console.error("[execution] submitter threw", describeError(error));
        result = { kind: "failed", code: "submit_error", message: "The order couldn't be sent. Retry the leg." };
      }
      const recorded = await recordLegResult(leg, view.basketId, result);
      await emitLegResult(recorded, view, { brokerageSlug: owned.brokerageSlug, owner, source: "submit" });
      yield { type: "leg", leg: toLegView(recorded) };
    }
  }

  const finalized = await finalizeExecution(view.id);
  const execution = await loadExecutionView(view.id);
  await recordSettlement(finalized, execution, owner);
  const active = execution.status === "queued" || execution.status === "running";
  yield { type: "done", execution, reason: active ? reason : "finished" };
}

/**
 * `leg_result` for one attempt, from the drain or from reconciliation. The
 * telemetry drawer counts one order per `legId`, using its latest result, so a
 * Live order that is accepted and later filled is one successful order.
 */
export async function emitLegResult(
  leg: ExecutionLeg,
  execution: Pick<ExecutionView, "id" | "kind" | "mode">,
  context: { brokerageSlug: string | null; owner: EventOwner; source: "submit" | "reconcile" },
): Promise<void> {
  const guest = context.owner.userId == null;
  await recordEvent(
    "leg_result",
    {
      executionId: execution.id,
      legId: leg.id,
      kind: execution.kind,
      mode: execution.mode,
      action: leg.action,
      status: leg.status,
      attempt: leg.attempt,
      brokerage: context.brokerageSlug ?? (guest ? "demo" : null),
      errorCode: leg.errorCode,
      latencyMs: leg.latencyMs,
      source: context.source,
      guest,
    },
    context.owner,
  );
}

/** basket_deployed on a deploy's first fill, basket_closed when a close has sold everything. */
export async function recordSettlement(
  finalized: Finalized | null,
  execution: ExecutionView,
  owner: EventOwner,
): Promise<void> {
  if (!finalized?.activated && !finalized?.closed) return;
  const summary = summarizeLegs(execution.legs);
  await recordEvent(
    finalized.activated ? "basket_deployed" : "basket_closed",
    {
      basketId: execution.basketId,
      executionId: execution.id,
      kind: execution.kind,
      mode: execution.mode,
      orders: summary.orders,
      filled: summary.filled,
      failed: summary.failed,
      currency: execution.currency,
      guest: owner.userId == null,
    },
    owner,
  );
}
