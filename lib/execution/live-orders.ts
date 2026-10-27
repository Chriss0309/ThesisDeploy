import type { AccountOrderRecord } from "snaptrade-typescript-sdk";

import { ReauthRequiredError } from "@/lib/auth/vault";
import { liveTradingEnabled } from "@/lib/env";
import { describeError } from "@/lib/errors";
import type { SubmitLeg, SubmitResult, Submitter } from "@/lib/execution/submitters";
import { SnapTradeError, callSnapTrade, type SnapTradeContext } from "@/lib/snaptrade/client";

// Live orders through SnapTrade: whole-share market orders, good for the day,
// one per client_order_id. Statuses follow SnapTrade's AccountOrderRecord enum.

/** Still open at the broker: wait for reconciliation. */
const OPEN = new Set([
  "NONE",
  "PENDING",
  "ACCEPTED",
  "QUEUED",
  "TRIGGERED",
  "ACTIVATED",
  "PARTIAL",
  "REPLACE_PENDING",
  "REPLACED",
  "CANCEL_PENDING",
]);
const REFUSED = new Set(["REJECTED", "FAILED"]);
const CLOSED_UNFILLED = new Set(["CANCELED", "PARTIAL_CANCELED", "EXPIRED"]);

const quantity = (value: string | null | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const price = (value: string | null | undefined): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export type OutcomeContext = {
  institution: string;
  /** Reconciliation knows the order is done reporting; the first response may still be settling. */
  final: boolean;
  latencyMs: number;
  requestId: string | null;
};

/**
 * Maps an order record to a leg outcome. Whole shares only, so filled
 * quantities are floored. An executed order with no reported price stays open
 * until reconciliation, which falls back to the pre-flight price.
 */
export function orderOutcome(record: AccountOrderRecord, leg: Pick<SubmitLeg, "units" | "estPrice">, ctx: OutcomeContext): SubmitResult {
  const status = String(record.status ?? "NONE").toUpperCase();
  const orderId = record.brokerage_order_id ?? "";
  const filled = Math.min(leg.units, Math.floor(quantity(record.filled_quantity)));
  const fillPrice = price(record.execution_price);
  const base = { brokerageOrderId: orderId, snaptradeStatus: status, latencyMs: ctx.latencyMs, requestId: ctx.requestId };

  if (status === "EXECUTED") {
    const units = filled > 0 ? filled : leg.units;
    if (fillPrice == null && !ctx.final) return { kind: "working", ...base, filledUnits: 0, fillPrice: null };
    return {
      kind: "filled",
      ...base,
      filledUnits: units,
      fillPrice: fillPrice ?? leg.estPrice,
      note: fillPrice == null ? `${ctx.institution} didn't report a fill price, so the pre-flight price is recorded.` : null,
    };
  }
  if (REFUSED.has(status)) {
    return {
      kind: "rejected",
      code: "broker_rejected",
      message: `${ctx.institution} rejected the order (${status}).`,
      requestId: ctx.requestId,
      latencyMs: ctx.latencyMs,
      brokerageOrderId: orderId || null,
      snaptradeStatus: status,
    };
  }
  if (CLOSED_UNFILLED.has(status)) {
    const why = status === "EXPIRED" ? "expired at the end of the session" : `was canceled by ${ctx.institution}`;
    if (filled > 0) {
      return {
        kind: "filled",
        ...base,
        filledUnits: filled,
        fillPrice: fillPrice ?? leg.estPrice,
        note: `Partly filled: ${filled} of ${leg.units}; the rest ${why}.`,
      };
    }
    return {
      kind: "rejected",
      code: status === "EXPIRED" ? "broker_expired" : "broker_canceled",
      message: `The order ${why} without filling.`,
      requestId: ctx.requestId,
      latencyMs: ctx.latencyMs,
      brokerageOrderId: orderId || null,
      snaptradeStatus: status,
    };
  }
  if (!OPEN.has(status)) console.warn("[live] unrecognized order status", { status });
  return { kind: "working", ...base, filledUnits: filled, fillPrice };
}

export type LiveAccount = { accountId: string; brokerageSlug: string | null; institution: string };

/**
 * Places whole-share market orders. The kill switch is read on every leg, so
 * turning it off stops the rest of a run. A 429 means SnapTrade didn't take the
 * order; a 4xx is the broker's refusal; anything without an answer is
 * `unknown` and left for reconciliation, never resubmitted automatically.
 */
export function liveSubmitter(ctx: SnapTradeContext, account: LiveAccount): Submitter {
  return async (leg) => {
    if (!liveTradingEnabled()) {
      return { kind: "failed", code: "live_disabled", message: "Live trading was switched off. Nothing was sent." };
    }
    const startedAt = performance.now();
    const latency = () => Math.round(performance.now() - startedAt);
    try {
      const record = await callSnapTrade(
        ctx,
        "placeForceOrder",
        (api) =>
          api.trading.placeForceOrder({
            account_id: account.accountId,
            action: leg.action,
            symbol: leg.symbol,
            order_type: "Market",
            time_in_force: "Day",
            units: leg.units,
            client_order_id: leg.clientOrderId,
          }),
        { brokerageSlug: account.brokerageSlug },
      );
      return orderOutcome(record, leg, { institution: account.institution, final: false, latencyMs: latency(), requestId: null });
    } catch (error) {
      return submitFailure(error, account, latency());
    }
  };
}

function submitFailure(error: unknown, account: LiveAccount, latencyMs: number): SubmitResult {
  if (error instanceof ReauthRequiredError) {
    return { kind: "failed", code: "reauth_required", message: "Your SnapTrade session expired before this order was sent. Sign in again, then retry." };
  }
  if (!(error instanceof SnapTradeError)) {
    console.error("[live] order failed", describeError(error));
    return { kind: "unknown", code: "submit_uncertain", message: uncertain(account), requestId: null, latencyMs };
  }
  if (error.code === "rate_limited") return { kind: "retry_later", retryAfterSeconds: Math.max(1, error.retryAfterSeconds ?? 2) };
  if (error.code === "upstream" && error.status != null && error.status >= 400 && error.status < 500) {
    return {
      kind: "rejected",
      code: "broker_rejected",
      message: error.detail ?? `${account.institution} refused the order (HTTP ${error.status}).`,
      requestId: error.requestId,
      latencyMs,
    };
  }
  return { kind: "unknown", code: "submit_uncertain", message: uncertain(account), requestId: error.requestId, latencyMs };
}

const uncertain = (account: LiveAccount) =>
  `SnapTrade didn't confirm this order, so it may or may not have reached ${account.institution}. ThesisDeploy checks recent orders; it won't send it again on its own.`;
