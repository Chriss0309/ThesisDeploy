"use client";

import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { applyDrainEvent } from "@/lib/execution/client-state";
import { latestAttempts, needsReconcile } from "@/lib/execution/summary";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { readClientError } from "@/lib/trpc/errors";
import { RECONCILE_INTERVAL_MS, UNREACHABLE_MESSAGE } from "@/constants/execution";
import type { DrainEvent, ExecutionView } from "@/types/execution";

const isActive = (execution: ExecutionView) => execution.status === "queued" || execution.status === "running";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One drain covers ~40 legs; this bounds a page's automatic resumes. */
const MAX_DRAIN_ROUNDS = 12;
/** Order-status checks while a page is open: one per 15 seconds for about five minutes. */
const MAX_STATUS_CHECKS = 20;
/** The first check gives the broker a moment to fill a market order. */
const FIRST_CHECK_MS = 3000;

/**
 * Drives one execution from the browser: streams `drain`, re-drains while
 * legs are pending (time budget, dropped streams), and exposes retry and
 * cancel. Leaving the page stops the queue after the current leg. For Live,
 * it checks open orders at the broker every 15 seconds while the page is open.
 */
export function useExecution(initial: ExecutionView, { autoResume = false }: { autoResume?: boolean } = {}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const { mutateAsync: reconcile } = useMutation(trpc.executions.reconcile.mutationOptions());
  const { mutateAsync: retryLeg } = useMutation(trpc.executions.retryLeg.mutationOptions());
  const { mutateAsync: cancelRun } = useMutation(trpc.executions.cancel.mutationOptions());
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
    try {
      setExecution(await client.executions.get.query({ executionId: id }));
    } catch (caught) {
      if (!readClientError(caught)) throw caught;
    }
  }, [client, id]);

  const drain = useCallback(async () => {
    if (inflight.current && !inflight.current.signal.aborted) return;
    const controller = new AbortController();
    inflight.current = controller;
    setDraining(true);
    setError(null);
    try {
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
        let events;
        try {
          events = await client.executions.drain.mutate({ executionId: id }, { signal: controller.signal });
        } catch (caught) {
          const failure = readClientError(caught);
          if (!failure) throw caught;
          return setError(failure.message);
        }
        let done: Extract<DrainEvent, { type: "done" }> | null = null;
        try {
          for await (const event of events) {
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
  }, [client, id, refresh]);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const body = await reconcile({ executionId: id });
      setExecution(body.execution);
      setNextCheckAt(body.nextCheckAt ? Date.parse(body.nextCheckAt) : null);
    } catch (caught) {
      setError(readClientError(caught)?.message ?? "Couldn't reach ThesisDeploy to check order status. Try again.");
    } finally {
      setChecking(false);
    }
  }, [reconcile, id]);

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
        setExecution(await retryLeg({ executionId: id, legId, options }));
      } catch (caught) {
        return setError(readClientError(caught)?.message ?? UNREACHABLE_MESSAGE);
      } finally {
        setBusyLeg(null);
      }
      await drain();
    },
    [retryLeg, id, drain],
  );

  const cancel = useCallback(async () => {
    setError(null);
    try {
      setExecution(await cancelRun({ executionId: id }));
    } catch (caught) {
      setError(readClientError(caught)?.message ?? UNREACHABLE_MESSAGE);
    }
  }, [cancelRun, id]);

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
