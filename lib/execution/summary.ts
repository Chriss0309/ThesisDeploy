import { MAX_LEG_ATTEMPTS, type ExecutionStatus, type LegStatus } from "@/lib/execution/types";

// Pure leg bookkeeping shared by the drain loop and the stepper UI.

const ACTIVE: ReadonlySet<string> = new Set(["pending", "claimed"]);
const FILLED: ReadonlySet<string> = new Set(["executed"]);
/** Live orders the broker still has open, some partly filled. */
const WORKING: ReadonlySet<string> = new Set(["accepted", "partial"]);
const RETRYABLE: ReadonlySet<string> = new Set(["rejected", "failed"]);

/** Database rows carry the status as a plain string. */
type LegLike = { seq: number; attempt: number; status: string };

/** The latest attempt for each order, by seq. */
export function latestAttempts<T extends LegLike>(legs: readonly T[]): T[] {
  const bySeq = new Map<number, T>();
  for (const leg of legs) {
    const current = bySeq.get(leg.seq);
    if (!current || leg.attempt > current.attempt) bySeq.set(leg.seq, leg);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export type LegSummary = {
  orders: number;
  filled: number;
  failed: number;
  pending: number;
  skipped: number;
  /** Accepted, partly filled, or unknown: sent, and not finished as far as ThesisDeploy knows. */
  open: number;
  /** The open legs the broker confirmed it has (accepted or partly filled). */
  working: number;
  /** Sent without an answer: may or may not be at the broker. */
  unknown: number;
};

export function summarizeLegs(legs: readonly LegLike[]): LegSummary {
  const summary: LegSummary = { orders: 0, filled: 0, failed: 0, pending: 0, skipped: 0, open: 0, working: 0, unknown: 0 };
  for (const leg of latestAttempts(legs)) {
    summary.orders++;
    if (ACTIVE.has(leg.status)) summary.pending++;
    else if (FILLED.has(leg.status)) summary.filled++;
    else if (RETRYABLE.has(leg.status)) summary.failed++;
    else if (leg.status === "skipped") summary.skipped++;
    else {
      summary.open++;
      if (WORKING.has(leg.status)) summary.working++;
      else summary.unknown++;
    }
  }
  return summary;
}

/**
 * `running` while any leg waits to be sent, `working` while the broker still
 * has open orders, then completed, partial, canceled, or failed. An unknown
 * leg keeps the run `partial` until reconciliation finds it or the user
 * confirms it never reached the broker.
 */
export function deriveStatus(legs: readonly LegLike[]): ExecutionStatus {
  const s = summarizeLegs(legs);
  if (s.pending > 0) return "running";
  if (s.working > 0) return "working";
  if (s.filled === s.orders) return "completed";
  if (s.filled > 0 || s.open > 0) return "partial";
  if (s.skipped > 0 && s.failed === 0) return "canceled";
  return "failed";
}

/** Only the latest attempt of a rejected or failed order can be retried, a few times at most. */
export function isRetryable(leg: LegLike, legs: readonly LegLike[]): boolean {
  if (!RETRYABLE.has(leg.status) || leg.attempt >= MAX_LEG_ATTEMPTS) return false;
  return !legs.some((other) => other.seq === leg.seq && other.attempt > leg.attempt);
}

export const isActiveLeg = (status: LegStatus) => ACTIVE.has(status);
export const isFilledLeg = (status: LegStatus) => FILLED.has(status);
/** Live legs reconciliation still has to settle. */
export const needsReconcile = (status: string) => WORKING.has(status) || status === "unknown";

/** "3 of 4 legs filled · 1 failed" */
export function summaryLine(summary: LegSummary): string {
  const parts = [`${summary.filled} of ${summary.orders} ${summary.orders === 1 ? "leg" : "legs"} filled`];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.pending > 0) parts.push(`${summary.pending} to go`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.working > 0) parts.push(`${summary.working} open at the broker`);
  if (summary.unknown > 0) parts.push(`${summary.unknown} unconfirmed`);
  return parts.join(" · ");
}
