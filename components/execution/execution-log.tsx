"use client";

import { RotateCcw } from "lucide-react";

import { LoaderGlyph } from "@/components/loader/loader";
import { formatMoney } from "@/components/portfolio/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { elapsedLabel, pacingLegId } from "@/lib/execution/client-state";
import { isRetryable, latestAttempts, summarizeLegs, summaryLine } from "@/lib/execution/summary";
import type { ExecutionStatus, ExecutionView, LegView } from "@/lib/execution/types";
import { cn } from "@/lib/utils";

const STATUS_BADGE: Record<ExecutionStatus, { tone: "neutral" | "positive" | "warning" | "negative"; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "warning", label: "Running" },
  completed: { tone: "positive", label: "Completed" },
  partial: { tone: "warning", label: "Partly filled" },
  failed: { tone: "negative", label: "Failed" },
  canceled: { tone: "neutral", label: "Canceled" },
};

export function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  const badge = STATUS_BADGE[status];
  return (
    <Badge tone={badge.tone} dot={status === "running"}>
      {badge.label}
    </Badge>
  );
}

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

function LegBadge({ leg, pacing }: { leg: LegView; pacing: boolean }) {
  switch (leg.status) {
    case "pending":
      return pacing ? (
        <Badge className="animate-pace">Pacing · 1 req/sec</Badge>
      ) : (
        <Badge>Queued</Badge>
      );
    case "claimed":
      return (
        <Badge tone="warning" dot>
          Submitting
        </Badge>
      );
    case "executed":
      return <Badge tone="positive">Filled</Badge>;
    case "accepted":
      return <Badge tone="positive">Submitted</Badge>;
    case "partial":
      return <Badge tone="warning">Partly filled</Badge>;
    case "rejected":
      return <Badge tone="negative">Rejected</Badge>;
    case "failed":
      return <Badge tone="negative">Failed</Badge>;
    case "unknown":
      return <Badge tone="warning">Unknown</Badge>;
    case "skipped":
      return <Badge>Skipped</Badge>;
  }
}

function LegRow({
  leg,
  history,
  total,
  execution,
  startedAt,
  current,
  pacing,
  retryable,
  busy,
  retrying,
  onRetry,
}: {
  leg: LegView;
  history: LegView[];
  total: number;
  execution: ExecutionView;
  /** The execution start, or its first claim while the start is still unknown to the browser. */
  startedAt: string | null;
  current: boolean;
  pacing: boolean;
  retryable: boolean;
  busy: boolean;
  /** This leg's retry request is in flight. */
  retrying: boolean;
  onRetry?: (legId: string) => void;
}) {
  const { currency } = execution;
  const failed = leg.status === "rejected" || leg.status === "failed";
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={cn(
        "grid animate-in grid-cols-(--grid-log) items-start gap-x-3 px-3 py-2.5 fade-in-0 duration-(--duration-base)",
        current && "bg-surface-sunken",
      )}
    >
      <span className="text-muted-foreground tabular-nums">[{leg.claimedAt ? elapsedLabel(startedAt, leg.claimedAt) : "—"}]</span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-pretty">
          Leg {leg.seq}/{total} · {leg.action} {leg.units} <span className="font-medium">{leg.symbol}</span> @ MKT
          {leg.attempt > 1 && <span className="text-muted-foreground"> · attempt {leg.attempt}</span>}
        </span>
        {(leg.status === "executed" || leg.status === "partial") && leg.fillPrice != null && (
          <span className="text-muted-foreground tabular-nums">
            {leg.filledUnits} @ {formatMoney(leg.fillPrice, currency)}
            {leg.brokerageOrderId && <> · order {shortId(leg.brokerageOrderId)}</>}
          </span>
        )}
        {(leg.status === "pending" || leg.status === "claimed") && (
          <span className="text-muted-foreground tabular-nums">est. {formatMoney(leg.units * leg.estPrice, currency)}</span>
        )}
        {history.map((attempt) => (
          <span key={attempt.id} className="font-sans text-muted-foreground">
            Attempt {attempt.attempt} {attempt.status}: {attempt.errorMessage ?? "no reason given"}
          </span>
        ))}
        {(failed || leg.status === "unknown") && leg.errorMessage && (
          <span className="font-sans text-negative-subtle-foreground">{leg.errorMessage}</span>
        )}
        {retryable && onRetry && (
          <Button
            variant="outline"
            size="xs"
            className="self-start font-sans"
            disabled={busy}
            onClick={() => onRetry(leg.id)}
          >
            {retrying ? <LoaderGlyph fallback={<RotateCcw />} /> : <RotateCcw />} Retry failed leg
          </Button>
        )}
      </div>
      <span className="justify-self-end">
        <LegBadge leg={leg} pacing={pacing} />
      </span>
    </li>
  );
}

/**
 * The paced execution stepper: a validation row, then one row per order
 * (latest attempt, with earlier attempts as notes), a progress bar, and a
 * running summary. Failed legs stay visible with their reason and a retry.
 */
export function ExecutionLog({
  execution,
  draining,
  busyLeg,
  onRetry,
}: {
  execution: ExecutionView;
  draining: boolean;
  busyLeg?: string | null;
  onRetry?: (legId: string) => void;
}) {
  const latest = latestAttempts(execution.legs);
  const summary = summarizeLegs(execution.legs);
  const settled = summary.orders - summary.pending;
  const claimed = latest.find((leg) => leg.status === "claimed");
  const pacing = pacingLegId(execution, draining);
  const current = claimed ?? latest.find((leg) => leg.id === pacing);
  const started = execution.legs.some((leg) => leg.claimedAt);
  const startedAt =
    execution.startedAt ??
    execution.legs.reduce<string | null>(
      (first, leg) => (leg.claimedAt && (!first || leg.claimedAt < first) ? leg.claimedAt : first),
      null,
    );

  return (
    <section aria-label="Execution progress" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex flex-col gap-1">
          <p className="eyebrow text-muted-foreground">► Execution · 1 order per second</p>
          <p className="font-display text-xl font-semibold tabular-nums">{summaryLine(summary)}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {execution.mode === "paper" ? (
            <Badge tone="info">Paper</Badge>
          ) : (
            <Badge tone="solid" dot>
              Live
            </Badge>
          )}
          <ExecutionStatusBadge status={execution.status} />
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Legs settled"
        aria-valuemin={0}
        aria-valuemax={summary.orders}
        aria-valuenow={settled}
        className="h-1 w-full overflow-hidden rounded-full bg-chart-track"
      >
        <div
          className="h-full bg-brand transition-all duration-(--duration-base)"
          style={{ width: `${summary.orders > 0 ? (settled / summary.orders) * 100 : 0}%` }}
        />
      </div>
      <ol aria-live="polite" className="flex flex-col divide-y rounded-md border font-mono text-xs">
        <li className="grid grid-cols-(--grid-log) items-start gap-x-3 px-3 py-2.5">
          <span className="text-muted-foreground tabular-nums">[00:00s]</span>
          <span className="text-pretty">Validated pre-flight · account, prices, market hours</span>
          <span className="justify-self-end">
            {started ? (
              <Badge tone="positive">Checked</Badge>
            ) : draining ? (
              <Badge tone="warning" dot>
                Validating
              </Badge>
            ) : (
              <Badge>Ready</Badge>
            )}
          </span>
        </li>
        {latest.map((leg) => (
          <LegRow
            key={leg.id}
            leg={leg}
            history={execution.legs.filter((other) => other.seq === leg.seq && other.attempt < leg.attempt)}
            total={summary.orders}
            execution={execution}
            startedAt={startedAt}
            current={current?.id === leg.id}
            pacing={leg.id === pacing}
            retryable={execution.status !== "canceled" && isRetryable(leg, execution.legs)}
            busy={busyLeg === leg.id || draining}
            retrying={busyLeg === leg.id}
            onRetry={onRetry}
          />
        ))}
      </ol>
    </section>
  );
}
