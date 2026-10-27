"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ExecutionLoader } from "@/components/execution/execution-loader";
import { ExecutionLog } from "@/components/execution/execution-log";
import { useExecution } from "@/components/execution/use-execution";
import { LoaderGlyph } from "@/components/loader/loader";
import { formatTimestamp } from "@/components/portfolio/format";
import { Button } from "@/components/ui/button";
import { stackLegs } from "@/lib/execution/client-state";
import { summarizeLegs, summaryLine } from "@/lib/execution/summary";
import type { ExecutionView } from "@/lib/execution/types";

export type ExecutionState = { execution: ExecutionView; active: boolean; draining: boolean };

/**
 * The stepper plus its controls: resume, cancel the remaining legs, and retry
 * failed legs. While legs are pending, the stacks loader shows one stack per
 * leg and settles out once the run ends. `actions` render once it has settled.
 */
export function ExecutionPanel({
  initial,
  autoResume,
  onStateChange,
  actions,
}: {
  initial: ExecutionView;
  autoResume: boolean;
  onStateChange?: (state: ExecutionState) => void;
  actions?: ReactNode;
}) {
  const { execution, draining, error, busyLeg, active, drain, retry, cancel, awaiting, checking, checkStatus } = useExecution(
    initial,
    { autoResume },
  );
  const summary = summarizeLegs(execution.legs);
  const [showStacks, setShowStacks] = useState(active);
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setShowStacks(true);
  }
  const legs = useMemo(() => stackLegs(execution, draining), [execution, draining]);

  useEffect(() => {
    onStateChange?.({ execution, active, draining });
  }, [execution, active, draining, onStateChange]);

  return (
    <div className="flex flex-col gap-4">
      {showStacks && (
        <ExecutionLoader
          label={draining ? "Submitting one leg per second…" : summaryLine(summary)}
          legs={legs}
          settled={!active}
          onSettled={() => setShowStacks(false)}
        />
      )}
      <ExecutionLog execution={execution} draining={draining} busyLeg={busyLeg} onRetry={retry} />
      {awaiting && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-subtle px-3 py-2.5 text-xs text-warning-subtle-foreground"
        >
          <p className="max-w-prose">
            {summary.working > 0 && `${summary.working} ${summary.working === 1 ? "order is" : "orders are"} open at ${execution.institution}. `}
            {summary.unknown > 0 &&
              `${summary.unknown} ${summary.unknown === 1 ? "order wasn't" : "orders weren't"} confirmed by SnapTrade and won't be sent again on their own. `}
            {execution.reconciledAt ? `Last checked ${formatTimestamp(execution.reconciledAt)}. ` : ""}
            ThesisDeploy checks every 15 seconds while this page is open.
          </p>
          <Button variant="outline" size="xs" disabled={checking} onClick={() => void checkStatus()}>
            {checking ? <LoaderGlyph variant="scan" fallback={<RefreshCw />} /> : <RefreshCw />} Check status now
          </Button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-negative-border bg-negative-subtle px-3 py-2.5 text-xs text-negative-subtle-foreground"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!draining && (
          <p className="text-xs text-muted-foreground">
            {active
              ? "Paused with legs left to submit. Filled legs are saved."
              : execution.status === "canceled"
                ? "Canceled. Filled legs stay in the basket."
                : awaiting
                  ? `Every order was sent. Fills are recorded as ${execution.institution} reports them.`
                  : "Done. Every fill is recorded in the basket ledger."}
          </p>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {active && (
            <Button variant="outline" size="sm" onClick={() => void cancel()}>
              Cancel remaining legs
            </Button>
          )}
          {active && !draining && (
            <Button size="sm" onClick={() => void drain()}>
              Resume execution
            </Button>
          )}
          {!active && actions}
        </div>
      </div>
    </div>
  );
}
