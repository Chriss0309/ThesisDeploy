"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type Status =
  | { state: "checking" }
  | { state: "ready"; latencyMs: number }
  | { state: "degraded" }
  | { state: "offline" };

const LABELS: Record<Status["state"], string> = {
  checking: "Waking backend…",
  ready: "Backend ready",
  degraded: "Backend degraded",
  offline: "Backend unreachable",
};

const DOT: Record<Status["state"], string> = {
  checking: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-500",
  degraded: "bg-amber-500",
  offline: "bg-red-500",
};

export function BackendStatus() {
  const [status, setStatus] = useState<Status>({ state: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = performance.now();

    fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        setStatus(
          response.ok
            ? {
                state: "ready",
                latencyMs: Math.round(performance.now() - startedAt),
              }
            : { state: "degraded" },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ state: "offline" });
      });

    return () => controller.abort();
  }, []);

  return (
    <a
      href="/api/health"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <span className={cn("size-2 rounded-full", DOT[status.state])} />
      {LABELS[status.state]}
      {status.state === "ready" && (
        <span className="tabular-nums">· {status.latencyMs} ms</span>
      )}
    </a>
  );
}
