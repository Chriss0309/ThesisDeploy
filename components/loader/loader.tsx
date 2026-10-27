"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { classes as cn } from "./classes";
import { defineMotionElements, type MotifElementApi } from "./element";
import { DEFAULT_TIMING, parseMs, settleHold, type ExecutionProgress, type LoaderVariant } from "./timing";

export type { ExecutionLeg, ExecutionProgress, LegStatus, LoaderVariant } from "./timing";

// <td-motif> does the work (delay, lazy three.js, pause), so a loader
// streamed in an unhydrated Suspense fallback animates too. React only feeds it live
// progress and holds the content back while the motif settles.
defineMotionElements();

type Options = {
  variant: LoaderVariant;
  delayMs?: number;
  progress?: ExecutionProgress;
  settled?: boolean;
  onSettled?: () => void;
};

function useMotif({ progress, settled = false, onSettled }: Options) {
  const ref = useRef<MotifElementApi>(null);
  const latest = useRef(onSettled);
  useEffect(() => {
    latest.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    if (ref.current) ref.current.progress = progress;
  }, [progress]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.settled = settled;
    if (!settled) return;
    const style = getComputedStyle(document.documentElement);
    const hold = settleHold({
      shownAt: element.shownAt,
      finishedAt: performance.now(),
      minVisibleMs: parseMs(style.getPropertyValue("--loader-min-visible"), DEFAULT_TIMING.minVisibleMs),
      settleMs: parseMs(style.getPropertyValue("--loader-settle"), DEFAULT_TIMING.settleMs),
    });
    const timer = window.setTimeout(() => latest.current?.(), hold);
    return () => window.clearTimeout(timer);
  }, [settled]);

  return ref;
}

const delayStyle = (delayMs?: number) =>
  delayMs != null ? ({ "--loader-delay": `${delayMs}ms` } as CSSProperties) : undefined;

export type LoaderProps = Options & {
  /** What is happening, in plain words. Read by screen readers through role="status". */
  label: string;
  detail?: ReactNode;
  /** inline: a glyph and one line; panel: replaces a card; showpiece: the Studio stage. */
  size?: "inline" | "panel" | "showpiece";
  eyebrow?: string;
  framed?: boolean;
  className?: string;
  children?: ReactNode;
};

export function Loader({
  label,
  detail,
  size = "panel",
  eyebrow,
  framed = size !== "inline",
  className,
  children,
  ...options
}: LoaderProps) {
  const ref = useMotif(options);
  const style = delayStyle(options.delayMs);
  const appear = "animate-loader-appear";
  const delay = options.delayMs != null ? `${options.delayMs}ms` : undefined;

  if (size === "inline") {
    return (
      <span
        role="status"
        aria-live="polite"
        aria-busy="true"
        style={style}
        className={cn("inline-flex items-center gap-2 align-middle text-xs", className)}
      >
        <td-motif ref={ref} variant={options.variant} delay={delay} className="contents">
          <canvas aria-hidden className={cn("size-(--loader-inline) shrink-0", appear)} />
        </td-motif>
        <span className={appear}>{label}</span>
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={style}
      className={cn(
        "flex flex-col gap-4",
        size === "panel" ? "min-h-(--loader-panel) items-center justify-center p-6 text-center" : "min-h-(--loader-showpiece) p-5 sm:p-6",
        framed && "rounded-lg bg-card text-card-foreground shadow-xs ring-1 ring-border",
        className,
      )}
    >
      {eyebrow && <p className={cn("eyebrow text-muted-foreground", appear)}>► {eyebrow}</p>}
      <td-motif ref={ref} variant={options.variant} delay={delay} className="contents">
        <canvas
          aria-hidden
          className={cn(
            "w-full",
            size === "showpiece"
              ? "h-(--loader-showpiece-stage-sm) sm:h-(--loader-showpiece-stage)"
              : cn(
                  "h-(--loader-stage)",
                  options.variant === "stacks" ? "max-w-(--loader-stage-wide)" : "max-w-(--loader-stage-width)",
                ),
            appear,
          )}
        />
      </td-motif>
      <div className={cn("flex flex-col gap-1.5", size === "panel" && "items-center", appear)}>
        <p className="font-display text-lg font-semibold">{label}</p>
        {detail && <div className="max-w-prose text-sm text-muted-foreground">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

/** Decorative glyph for buttons and pills; another element announces the state. */
export function LoaderGlyph({
  variant = "coin",
  fallback,
  className,
}: {
  variant?: LoaderVariant;
  /** Shown during the appear delay, usually the icon the glyph replaces. */
  fallback?: ReactNode;
  /** Sizing classes; defaults to the 16 px icon size. */
  className?: string;
}) {
  const ref = useMotif({ variant });
  return (
    <td-motif
      ref={ref}
      variant={variant}
      aria-hidden="true"
      className={cn("group/glyph relative inline-grid shrink-0 place-items-center", className ?? "size-4")}
    >
      {fallback && <span className="contents group-data-shown/glyph:hidden">{fallback}</span>}
      <canvas className="invisible absolute inset-0 size-full group-data-shown/glyph:visible" />
    </td-motif>
  );
}
