"use client";

import { useEffect, useState } from "react";

import { LoaderGlyph } from "@/components/loader/loader";
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
  checking: "bg-warning animate-pace",
  ready: "bg-positive",
  degraded: "bg-warning",
  offline: "bg-negative",
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
      className="inline-flex h-7 items-center gap-2 rounded-sm border border-border-strong bg-card px-2.5 font-mono text-2xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <span className="grid size-(--loader-dot) shrink-0 place-items-center">
        {status.state === "checking" ? (
          <LoaderGlyph className="size-(--loader-dot)" fallback={<span className={cn("size-1.5 rounded-full", DOT.checking)} />} />
        ) : (
          <span className={cn("size-1.5 rounded-full", DOT[status.state])} />
        )}
      </span>
      {LABELS[status.state]}
      {status.state === "ready" && (
        <span className="tabular-nums">· {status.latencyMs} ms</span>
      )}
    </a>
  );
}
