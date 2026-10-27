"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { classes as cn } from "./classes";
import type { LoaderView } from "./engine";
import type { Palette, Rgb } from "./motifs";
import { DEFAULT_TIMING, appearDelay, parseMs, settleHold, type ExecutionProgress, type LoaderVariant } from "./timing";

export type { ExecutionLeg, ExecutionProgress, LegStatus, LoaderVariant } from "./timing";

// three.js and every motif live in one lazy chunk, fetched the first time a loader
// actually appears; loads that finish within the delay never download it.
let engine: Promise<typeof import("./engine")> | null = null;
const loadEngine = () => (engine ??= import("./engine"));

// When a loader hands over to another of the same variant (loading.tsx to a Suspense
// fallback), the newcomer skips the delay so the motif doesn't blink.
const lastVisible = new Map<LoaderVariant, number>();
let initialLoad = typeof document !== "undefined" && document.readyState !== "complete";
if (initialLoad) window.addEventListener("load", () => (initialLoad = false), { once: true });

function timing() {
  const style = getComputedStyle(document.documentElement);
  return {
    delayMs: parseMs(style.getPropertyValue("--loader-delay"), DEFAULT_TIMING.delayMs),
    minVisibleMs: parseMs(style.getPropertyValue("--loader-min-visible"), DEFAULT_TIMING.minVisibleMs),
    settleMs: parseMs(style.getPropertyValue("--loader-settle"), DEFAULT_TIMING.settleMs),
  };
}

let probe: CanvasRenderingContext2D | null = null;
function toRgba(color: string): [number, number, number, number] {
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe || !color) return [0, 0, 0, 0];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255, a / 255];
}

/** Ink is the text color around the loader, paper the nearest opaque surface behind it. */
function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  let paper: Rgb | null = null;
  for (let node: Element | null = element; node && !paper; node = node.parentElement) {
    const [r, g, b, a] = toRgba(getComputedStyle(node).backgroundColor);
    if (a > 0.98) paper = [r, g, b];
  }
  const channels = (value: string): Rgb => toRgba(value).slice(0, 3) as Rgb;
  return {
    paper: paper ?? channels(getComputedStyle(document.body).backgroundColor),
    ink: channels(style.color),
    accent: channels(style.getPropertyValue("--brand")),
    negative: channels(style.getPropertyValue("--negative")),
  };
}

type Options = {
  variant: LoaderVariant;
  delayMs?: number;
  progress?: ExecutionProgress;
  settled?: boolean;
  onSettled?: () => void;
};

// Overrides --loader-delay for one loader's subtree when it takes over from another.
const INSTANT = { "--loader-delay": "0ms" } as CSSProperties;

function useLoader({ variant, delayMs, progress, settled = false, onSettled }: Options) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<LoaderView | null>(null);
  const shownAt = useRef<number | null>(null);
  const latest = useRef({ progress, settled, onSettled });
  const [shown, setShown] = useState(false);
  // Client-only state: during hydration lastVisible is empty, so this matches the server.
  const [instant] = useState(() => {
    if (typeof window === "undefined") return false;
    const seen = lastVisible.get(variant);
    return seen != null && performance.now() - seen < timing().delayMs;
  });

  useEffect(() => {
    latest.current = { progress, settled, onSettled };
    viewRef.current?.update({ progress, settled });
  }, [progress, settled, onSettled]);

  useEffect(() => {
    const now = performance.now();
    const wait = appearDelay({
      delayMs: delayMs ?? timing().delayMs,
      now,
      lastVisibleAt: lastVisible.get(variant),
      sincePageStart: initialLoad ? now : undefined,
    });
    const timer = window.setTimeout(() => {
      shownAt.current = performance.now();
      setShown(true);
    }, wait);
    return () => {
      window.clearTimeout(timer);
      if (shownAt.current != null) lastVisible.set(variant, performance.now());
    };
  }, [variant, delayMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!shown || !canvas) return;
    let cancelled = false;
    let view: LoaderView | null = null;
    const resize = new ResizeObserver(() => {
      const box = canvas.getBoundingClientRect();
      view?.resize(box.width, box.height);
    });
    const intersection = new IntersectionObserver(([entry]) => view?.setVisible(entry.isIntersecting));
    loadEngine()
      .then(({ attachLoader }) => {
        if (cancelled) return;
        try {
          view = attachLoader(canvas, {
            variant,
            palette: readPalette(canvas),
            progress: latest.current.progress,
            settled: latest.current.settled,
            settleMs: timing().settleMs,
          });
        } catch {
          return; // No WebGL: the status text carries the state on its own.
        }
        viewRef.current = view;
        const box = canvas.getBoundingClientRect();
        view.resize(box.width, box.height);
        resize.observe(canvas);
        intersection.observe(canvas);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      resize.disconnect();
      intersection.disconnect();
      view?.dispose();
      viewRef.current = null;
    };
  }, [shown, variant]);

  useEffect(() => {
    if (!settled) return;
    const t = timing();
    const hold = settleHold({
      shownAt: shownAt.current,
      finishedAt: performance.now(),
      minVisibleMs: t.minVisibleMs,
      settleMs: t.settleMs,
    });
    const timer = window.setTimeout(() => latest.current.onSettled?.(), hold);
    return () => window.clearTimeout(timer);
  }, [settled]);

  return { canvasRef, shown, style: instant ? INSTANT : delayMs != null ? ({ "--loader-delay": `${delayMs}ms` } as CSSProperties) : undefined };
}

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
  const { canvasRef, style } = useLoader(options);
  const appear = "animate-loader-appear";

  if (size === "inline") {
    return (
      <span
        role="status"
        aria-live="polite"
        aria-busy="true"
        style={style}
        className={cn("inline-flex items-center gap-2 align-middle text-xs", className)}
      >
        <canvas ref={canvasRef} aria-hidden className={cn("size-(--loader-inline) shrink-0", appear)} />
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
      <canvas
        ref={canvasRef}
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
  const { canvasRef, shown, style } = useLoader({ variant });
  return (
    <span aria-hidden style={style} className={cn("relative inline-grid shrink-0 place-items-center", className ?? "size-4")}>
      {!shown && fallback}
      <canvas ref={canvasRef} className={cn("absolute inset-0 size-full", !shown && "invisible")} />
    </span>
  );
}
