"use client";

import { useEffect, useRef, useState } from "react";

import type { LoaderView } from "@/components/loader/engine";
import { loadEngine } from "@/components/loader/element";
import { Badge } from "@/components/ui/badge";
import type { CoinPalette, CoinScene, Rgb } from "./coin-scene";
import { LEGS, TOTAL_SHARES, sharesPlaced, stepAt, type Step } from "./coin-timeline";

// Resolves any CSS color (hex, oklch, color-mix, ...) to sRGB through a 1x1 canvas.
function readTokenColor(element: Element, token: string): Rgb {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return [0, 0, 0];
  context.fillStyle = getComputedStyle(element).getPropertyValue(token).trim();
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

const sameStep = (a: Step, b: Step) =>
  a.phase === b.phase && (a.phase !== "leg" || (b.phase === "leg" && a.leg === b.leg));

function StepCard({ step }: { step: Step }) {
  if (step.phase === "preflight") {
    return (
      <>
        <span className="text-muted-foreground">► Pre-flight</span>
        <span>Checking buying power</span>
        <Badge tone="warning" dot>
          Validating
        </Badge>
      </>
    );
  }
  if (step.phase === "done") {
    return (
      <>
        <span className="text-muted-foreground">► Basket</span>
        <span>
          {LEGS.length}/{LEGS.length} legs submitted
        </span>
        <Badge tone="info">Paper</Badge>
      </>
    );
  }
  const leg = LEGS[step.leg];
  return (
    <>
      <span className="text-muted-foreground">
        ► Leg {step.leg + 1}/{LEGS.length}
      </span>
      <span>
        Buy {leg.shares} {leg.ticker} @ MKT
      </span>
      <Badge tone="positive" dot>
        Submitted
      </Badge>
    </>
  );
}

export function CoinStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [step, setStep] = useState<Step>({ phase: "preflight" });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    let view: LoaderView | null = null;
    let scene: CoinScene | null = null;
    let cancelled = false;
    let shown: Step = { phase: "preflight" };

    const publish = (time: number) => {
      const next = stepAt(time);
      if (!sameStep(next, shown)) {
        shown = next;
        setStep(next);
      }
    };

    const resize = () => {
      const { width, height } = stage.getBoundingClientRect();
      view?.resize(Math.max(width, 1), Math.max(height, 1));
    };

    const onPointer = (event: PointerEvent) => {
      const box = stage.getBoundingClientRect();
      scene?.setPointer(
        ((event.clientX - box.left) / box.width) * 2 - 1,
        ((event.clientY - box.top) / box.height) * 2 - 1,
      );
    };

    const resizeObserver = new ResizeObserver(resize);
    const intersection = new IntersectionObserver(([entry]) => view?.setVisible(entry.isIntersecting));

    // The shared loader engine draws the hero too: one WebGL context per page.
    Promise.all([loadEngine(), import("./coin-scene")])
      .then(([{ attachScene, constrainedDevice }, { createCoinScene }]) => {
        if (cancelled) return;
        const palette: CoinPalette = {
          paper: readTokenColor(stage, "--illustration-paper"),
          ink: readTokenColor(stage, "--illustration-ink"),
          accent: readTokenColor(stage, "--illustration-accent"),
        };
        // An endless loop keeps a phone's main thread and battery busy for as long as the page is open.
        scene = createCoinScene(palette, publish, { loop: !constrainedDevice });
        try {
          view = attachScene(canvas, scene);
        } catch {
          return; // No WebGL: the data cards still tell the story.
        }
        resize();
        setReady(true);
        resizeObserver.observe(stage);
        intersection.observe(stage);
        stage.addEventListener("pointermove", onPointer);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      intersection.disconnect();
      stage.removeEventListener("pointermove", onPointer);
      view?.dispose();
    };
  }, []);

  const placed = sharesPlaced(step);

  return (
    <div
      role="img"
      aria-label="Illustration: an engraved coin with a bull emblem spins while four order legs stack up as whole-share coins, one leg per second."
      className="relative mx-auto w-full max-w-(--coin-stage)"
    >
      <div ref={stageRef} className="relative aspect-4/3 w-full lg:aspect-square">
        <canvas
          ref={canvasRef}
          aria-hidden
          className="absolute inset-0 size-full opacity-0 transition-opacity duration-(--duration-slow) data-[ready=true]:opacity-100"
          data-ready={ready}
        />
      </div>
      <div aria-hidden className="mt-2 grid grid-cols-2 items-start gap-2 sm:contents">
        <div className="frame-marks flex flex-col gap-1.5 bg-surface-tint px-3 py-2.5 font-mono text-2xs tracking-badge uppercase sm:absolute sm:top-8 sm:left-0">
          <StepCard step={step} />
        </div>
        <div className="flex flex-col gap-0.5 rounded-md border border-border bg-card px-3 py-2.5 shadow-md sm:absolute sm:right-0 sm:bottom-36">
          <span className="eyebrow text-muted-foreground">Whole shares</span>
          <span className="font-display text-2xl font-semibold tabular-nums">
            {String(placed).padStart(2, "0")}
            <span className="text-muted-foreground">/{TOTAL_SHARES}</span>
          </span>
          <span className="font-mono text-2xs text-muted-foreground">1 order / sec</span>
        </div>
      </div>
    </div>
  );
}
