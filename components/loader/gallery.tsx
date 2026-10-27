"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Loader, LoaderGlyph, type ExecutionLeg, type ExecutionProgress } from "./loader";
import { NavigationStatus } from "./pending";

const BASKET = [
  { symbol: "VST", shares: 4 },
  { symbol: "ETN", shares: 6 },
  { symbol: "CCJ", shares: 12 },
  { symbol: "CEG", shares: 5 },
  { symbol: "NEE", shares: 8 },
  { symbol: "GEV", shares: 2 },
  { symbol: "TLN", shares: 7 },
  { symbol: "OKLO", shares: 9 },
];
const LEG_COUNTS = [4, 6, 8];
const STEP_MS = 1000;

/** A paced queue on a timer: one leg per second, the third leg rejected by the brokerage. */
function useSimulatedQueue(count: number): { progress: ExecutionProgress; label: string } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => (value + 1) % (count * 2 + 4)), STEP_MS / 2);
    return () => window.clearInterval(timer);
  }, [count]);
  const legs: ExecutionLeg[] = BASKET.slice(0, count).map((leg, i) => {
    const at = tick - i * 2;
    const status = at >= 2 ? (i === 2 ? "failed" : "submitted") : at === 1 ? "submitting" : at === 0 ? "pacing" : "queued";
    return { ...leg, status };
  });
  const current = legs.findIndex((leg) => leg.status === "pacing" || leg.status === "submitting");
  const failed = legs.filter((leg) => leg.status === "failed").length;
  const label =
    current >= 0
      ? `Submitting leg ${current + 1} of ${legs.length} · BUY ${legs[current].shares} ${legs[current].symbol} @ MKT`
      : `${legs.length - failed} of ${legs.length} legs submitted${failed ? ` · ${failed} failed` : ""}`;
  return { progress: { legs }, label };
}

export function LoaderGallery() {
  const [legCount, setLegCount] = useState(4);
  const queue = useSimulatedQueue(legCount);
  const [settled, setSettled] = useState(false);
  const [round, setRound] = useState(0);
  const [toast, setToast] = useState(false);

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4" aria-labelledby="motifs">
        <h2 id="motifs" className="eyebrow text-muted-foreground">
          Motifs
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Loader variant="coin" label="Loading ThesisDeploy…" detail="coin · generic and route waits, button glyphs" />
          <Loader variant="link" label="Checking your SnapTrade session…" detail="link · sign-in, session, sign-out" />
          <Loader variant="scan" label="Reading your accounts from SnapTrade…" detail="scan · Portfolio X-Ray and Studio accounts" />
        </div>
        <Loader
          key={round}
          variant="orbit"
          size="showpiece"
          eyebrow={settled ? "Basket ready" : "Building"}
          label={settled ? "Basket ready" : "Building your basket…"}
          detail="orbit · Studio generation and grounding; settles into whole-share lots on reveal"
          settled={settled}
          onSettled={() => undefined}
        >
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => setSettled(true)} disabled={settled}>
              Finish (settle)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSettled(false);
                setRound((value) => value + 1);
              }}
            >
              Restart
            </Button>
          </div>
        </Loader>
        <div className="grid gap-4 md:grid-cols-2">
          <Loader
            variant="stacks"
            label={queue.label}
            detail="stacks · live progress: paced, submitting, submitted, failed"
            progress={queue.progress}
          >
            <div className="flex items-center gap-2 pt-1" role="group" aria-label="Legs in the basket">
              <span className="eyebrow text-muted-foreground">Legs</span>
              {LEG_COUNTS.map((count) => (
                <Button
                  key={count}
                  size="sm"
                  variant={count === legCount ? "default" : "outline"}
                  aria-pressed={count === legCount}
                  onClick={() => setLegCount(count)}
                >
                  {count}
                </Button>
              ))}
            </div>
          </Loader>
          <Loader variant="stacks" label="Submitting orders…" detail="stacks · no progress given: an indeterminate loop" />
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="inline">
        <h2 id="inline" className="eyebrow text-muted-foreground">
          Inline, glyph, and toast
        </h2>
        <div className="flex flex-wrap items-center gap-6 rounded-lg bg-card p-5 ring-1 ring-border">
          <Loader variant="link" size="inline" label="Checking your SnapTrade session…" />
          <Button size="lg" disabled>
            <LoaderGlyph fallback={<Sparkles />} />
            Generate basket
          </Button>
          <Button variant="outline" onClick={() => setToast((value) => !value)}>
            {toast ? "Hide" : "Show"} navigation toast
          </Button>
        </div>
        <div className="dark rounded-lg p-5">
          <Loader variant="scan" size="inline" label="Inverse panels recolor automatically" />
        </div>
      </section>
      {toast && <NavigationStatus variant="link" label="Opening SnapTrade…" />}
    </div>
  );
}
