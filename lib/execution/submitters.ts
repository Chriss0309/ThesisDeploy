import { randomUUID } from "node:crypto";

// A submitter turns one claimed leg into an outcome. Paper fills on the spot;
// Live (lib/execution/live-orders.ts) places a SnapTrade market order.

export type SubmitLeg = {
  seq: number;
  attempt: number;
  action: "BUY" | "SELL";
  symbol: string;
  units: number;
  estPrice: number;
  clientOrderId: string;
};

export type SubmitResult =
  | {
      kind: "filled";
      brokerageOrderId: string;
      snaptradeStatus: string;
      filledUnits: number;
      fillPrice: number;
      latencyMs: number;
      requestId?: string | null;
      /** Set when the broker filled part of the order and closed the rest. */
      note?: string | null;
    }
  /** Live: the broker has the order and it is still open, possibly partly filled. */
  | {
      kind: "working";
      brokerageOrderId: string;
      snaptradeStatus: string;
      filledUnits: number;
      fillPrice: number | null;
      latencyMs: number;
      requestId: string | null;
    }
  /** The broker refused the order; nothing was bought or sold. */
  | {
      kind: "rejected";
      code: string;
      message: string;
      requestId: string | null;
      latencyMs: number;
      brokerageOrderId?: string | null;
      snaptradeStatus?: string | null;
    }
  /** The order never left the app. */
  | { kind: "failed"; code: string; message: string }
  /** Live: no answer (timeout or 5xx). The order may have reached the broker, so it is never resubmitted automatically. */
  | { kind: "unknown"; code: string; message: string; requestId: string | null; latencyMs: number }
  /** Rate limited before processing: the leg goes back to pending. */
  | { kind: "retry_later"; retryAfterSeconds: number };

export type Submitter = (leg: SubmitLeg) => Promise<SubmitResult>;

/**
 * Fills the whole leg at its pre-flight price. With failure injection, the
 * first attempt of one leg is rejected the way a broker would, so a retry fills.
 */
export function paperSubmitter({ simulateRejectSeq }: { simulateRejectSeq: number | null }): Submitter {
  return async (leg) => {
    if (simulateRejectSeq === leg.seq && leg.attempt === 1) {
      return {
        kind: "rejected",
        code: "simulated_rejection",
        message: `Simulated broker rejection (reviewer toggle on leg ${leg.seq}): the broker refused ${leg.action} ${leg.units} ${leg.symbol}. Nothing was bought.`,
        requestId: null,
        latencyMs: 0,
      };
    }
    return {
      kind: "filled",
      brokerageOrderId: `paper_${randomUUID().replaceAll("-", "")}`,
      snaptradeStatus: "EXECUTED",
      filledUnits: leg.units,
      fillPrice: leg.estPrice,
      latencyMs: 0,
    };
  };
}

/** Live legs when no Live submitter is configured, e.g. a drain without a signed-in user. */
export const liveUnavailable: Submitter = async () => ({
  kind: "failed",
  code: "live_unavailable",
  message: "Live orders need a signed-in SnapTrade session. Sign in again, then retry the leg.",
});
