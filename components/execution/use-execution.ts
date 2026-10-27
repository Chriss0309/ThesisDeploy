"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { applyDrainEvent, readNdjson } from "@/lib/execution/client-state";
import { latestAttempts, needsReconcile } from "@/lib/execution/summary";
import { RECONCILE_INTERVAL_MS, type DrainEvent, type ExecutionErrorBody, type ExecutionView } from "@/lib/execution/types";

const isActive = (execution: ExecutionView) => execution.status === "queued" || execution.status === "running";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One drain covers ~40 legs; this bounds a page's automatic resumes. */
const MAX_DRAIN_ROUNDS = 12;
/** Order-status checks while a page is open: one per 15 seconds for about five minutes. */
const MAX_STATUS_CHECKS = 20;
/** The first check gives the broker a moment to fill a market order. */
const FIRST_CHECK_MS = 3000;

type ReconcileBody = { execution: ExecutionView; checked: boolean; nextCheckAt: string | null };

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as ExecutionErrorBody | null;
  return body?.error.message ?? `Request failed (HTTP ${response.status}). Try again.`;
}

/**
 * Drives one execution from the browser: streams `drain`, re-drains while
 * legs are pending (time budget, dropped streams), and exposes retry and
 * cancel. Leaving the page stops the queue after the current leg. For Live,
 * it checks open orders at the broker every 15 seconds while the page is open.
 */
export function useExecution(initial: ExecutionView, { autoResume = false }: { autoResume?: boolean } = {}) {
  const [execution, setExecution] = useState(initial);
  const [draining, setDraining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyLeg, setBusyLeg] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [nextCheckAt, setNextCheckAt] = useState<number | null>(null);
  const checks = useRef(0);
  /** The in-flight drain; a new drain starts only when none is running. */
  const inflight = useRef<AbortController | null>(null);
  const startedActive = useRef(isActive(initial));
  const id = initial.id;

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/executions/${id}`, { cache: "no-store" });
    if (response.ok) setExecution((await response.json()) as ExecutionView);
  }, [id]);

  const drain = useCallback(async () => {
    if (inflight.current && !inflight.current.signal.aborted) return;
    const controller = new AbortController();
    inflight.current = controller;
    setDraining(true);
    setError(null);
    try {
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
        const response = await fetch(`/api/executions/${id}/drain`, { method: "POST", signal: controller.signal });
        if (!response.ok || !response.body) {
          setError(await errorMessage(response));
          return;
        }
        let done: Extract<DrainEvent, { type: "done" }> | null = null;
        try {
          for await (const event of readNdjson<DrainEvent>(response.body)) {
            if (event.type === "error") setError(event.message);
            if (event.type === "done") done = event;
            setExecution((current) => applyDrainEvent(current, event));
          }
        } catch (streamError) {
          if (controller.signal.aborted) return;
          console.warn("[execution] stream interrupted", streamError);
        }
        if (!done) {
          // The stream dropped mid-run: re-read the state, then resume.
          await wait(1000);
          await refresh();
          continue;
        }
        if (!isActive(done.execution) || done.reason === "aborted") return;
        await wait(done.reason === "waiting" ? 2000 : 250);
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      console.warn("[execution] drain failed", caught);
      setError("Lost the connection to the queue. Resume to continue; filled legs are saved.");
      await refresh().catch(() => undefined);
    } finally {
      if (inflight.current === controller) {
        inflight.current = null;
        setDraining(false);
      }
    }
  }, [id, refresh]);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch(`/api/executions/${id}/reconcile`, { method: "POST" });
      if (!response.ok) return setError(await errorMessage(response));
      const body = (await response.json()) as ReconcileBody;
      setExecution(body.execution);
      setNextCheckAt(body.nextCheckAt ? Date.parse(body.nextCheckAt) : null);
    } catch {
      setError("Couldn't reach ThesisDeploy to check order status. Try again.");
    } finally {
      setChecking(false);
    }
  }, [id]);

  const awaiting =
    execution.mode === "live" && !draining && latestAttempts(execution.legs).some((leg) => needsReconcile(leg.status));
  useEffect(() => {
    if (!awaiting || checks.current >= MAX_STATUS_CHECKS) return;
    const delay = nextCheckAt == null ? FIRST_CHECK_MS : Math.max(500, nextCheckAt - Date.now());
    const timer = setTimeout(() => {
      checks.current++;
      void checkStatus();
    }, delay);
    return () => clearTimeout(timer);
  }, [awaiting, nextCheckAt, checkStatus]);

  const retry = useCallback(
    async (legId: string, options: { confirmNotPlaced?: boolean } = {}) => {
      setBusyLeg(legId);
      setError(null);
      try {
        const response = await fetch(`/api/executions/${id}/legs/${legId}/retry`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options),
        });
        if (!response.ok) return setError(await errorMessage(response));
        setExecution((await response.json()) as ExecutionView);
      } finally {
        setBusyLeg(null);
      }
      await drain();
    },
    [id, drain],
  );

  const cancel = useCallback(async () => {
    setError(null);
    const response = await fetch(`/api/executions/${id}/cancel`, { method: "POST" });
    if (!response.ok) return setError(await errorMessage(response));
    setExecution((await response.json()) as ExecutionView);
  }, [id]);

  // Leaving the page aborts the stream, and the server stops claiming legs.
  useEffect(() => {
    if (autoResume && startedActive.current) void drain();
    return () => inflight.current?.abort();
  }, [autoResume, drain]);

  return {
    execution,
    draining,
    error,
    busyLeg,
    active: isActive(execution),
    drain,
    retry,
    cancel,
    /** Live: orders the broker hasn't settled, and the order-status check. */
    awaiting,
    checking,
    nextCheckAt,
    checkStatus,
    intervalMs: RECONCILE_INTERVAL_MS,
  };
}
