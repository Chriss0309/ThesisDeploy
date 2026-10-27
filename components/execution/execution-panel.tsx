"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ExecutionLoader } from "@/components/execution/execution-loader";
import { ExecutionLog } from "@/components/execution/execution-log";
import { useExecution } from "@/components/execution/use-execution";
import { Mark } from "@/components/loader/mark";
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
  const { execution, draining, error, busyLeg, active, drain, retry, cancel } = useExecution(initial, { autoResume });
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
          label={draining ? "Submitting one leg per second…" : summaryLine(summarizeLegs(execution.legs))}
          legs={legs}
          settled={!active}
          onSettled={() => setShowStacks(false)}
        />
      )}
      <ExecutionLog execution={execution} draining={draining} busyLeg={busyLeg} onRetry={retry} />
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
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {!active && execution.status === "completed" && <Mark kind="success" size="inline" />}
            {!active && (execution.status === "partial" || execution.status === "failed") && (
              <Mark kind="error" size="inline" />
            )}
            {active
              ? "Paused with legs left to submit. Filled legs are saved."
              : execution.status === "canceled"
                ? "Canceled. Filled legs stay in the basket."
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
