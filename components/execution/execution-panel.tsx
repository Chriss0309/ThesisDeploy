"use client";

import { useEffect, type ReactNode } from "react";

import { ExecutionLoader } from "@/components/execution/execution-loader";
import { ExecutionLog } from "@/components/execution/execution-log";
import { useExecution } from "@/components/execution/use-execution";
import { Button } from "@/components/ui/button";
import type { ExecutionView } from "@/lib/execution/types";

export type ExecutionState = { execution: ExecutionView; active: boolean; draining: boolean };

/**
 * The stepper plus its controls: resume, cancel the remaining legs, and retry
 * failed legs. `actions` render once the execution has settled.
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

  useEffect(() => {
    onStateChange?.({ execution, active, draining });
  }, [execution, active, draining, onStateChange]);

  return (
    <div className="flex flex-col gap-4">
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
        {draining ? (
          <ExecutionLoader variant="execution" label="Submitting one leg per second…" />
        ) : active ? (
          <p className="text-xs text-muted-foreground">Paused with legs left to submit. Filled legs are saved.</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {execution.status === "canceled"
              ? "Canceled. Filled legs stay in the basket."
              : "Done. Every fill is recorded in the basket ledger."}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
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
