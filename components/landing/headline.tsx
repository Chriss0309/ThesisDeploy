"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const LINES = [
  ["a", "thesis"],
  ["an", "idea"],
  ["a", "conviction"],
  ["a", "narrative"],
] as const;

// Four words in one pass, still readable, and finished in under 3 seconds.
const STEP_MS = 700;

export function LandingHeadline() {
  const [motion, setMotion] = useState<"pending" | "reduce" | "ok">("pending");
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotion(media.matches ? "reduce" : "ok");
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (motion !== "ok") return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % LINES.length), STEP_MS);
    return () => window.clearInterval(timer);
  }, [motion]);

  if (motion !== "ok") {
    return (
      <h1 className="max-w-4xl font-display text-display font-semibold text-balance">
        Invest in a <span className="text-highlight">thesis</span>.
      </h1>
    );
  }

  return (
    <h1 className="max-w-4xl font-display text-display font-semibold text-balance">
      <span className="sr-only">Invest in a thesis.</span>
      <span aria-hidden className="inline-grid justify-items-center">
        {LINES.map(([article, word], line) => (
          <span
            key={word}
            className={cn(
              "col-start-1 row-start-1 transition-opacity duration-(--duration-fast) ease-enter",
              line === index ? "opacity-100" : "opacity-0",
            )}
          >
            Invest in {article} <span className="text-highlight">{word}</span>.
          </span>
        ))}
      </span>
    </h1>
  );
}
