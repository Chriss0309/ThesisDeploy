"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { LoaderGlyph } from "@/components/loader/loader";
import { Button } from "@/components/ui/button";

const FIELD =
  "rounded-md border border-input bg-card px-2 py-1 text-base text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-50 md:text-sm";

const MOVES = [
  { value: "0.5", label: "+50%" },
  { value: "1", label: "+100%" },
  { value: "-0.4", label: "−40%" },
];

/**
 * Demo only: fixture quotes never move, so this reviewer tool scales one
 * ticker's demo price to show the drift flag and a rebalance.
 */
export function SimulateMove({ basketId, symbols, moves }: { basketId: string; symbols: string[]; moves: Record<string, number> | null }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [symbol, setSymbol] = useState(symbols[0] ?? "");
  const [change, setChange] = useState(MOVES[1].value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = pending || refreshing;
  const applied = Object.entries(moves ?? {}).filter(([, factor]) => factor !== 1);

  async function send(body: object) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/baskets/${basketId}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const parsed = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(parsed?.error?.message ?? `Request failed (HTTP ${response.status}).`);
        return;
      }
      startRefresh(() => router.refresh());
    } catch {
      setError("Couldn't reach ThesisDeploy. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong p-3">
      <legend className="eyebrow px-1 text-muted-foreground">Reviewer tools · Demo only</legend>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Simulate a market move:</span>
        <select aria-label="Ticker" className={FIELD} value={symbol} onChange={(event) => setSymbol(event.target.value)}>
          {symbols.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select aria-label="Price change" className={FIELD} value={change} onChange={(event) => setChange(event.target.value)}>
          {MOVES.map((move) => (
            <option key={move.value} value={move.value}>
              {move.label}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={working || !symbol} onClick={() => void send({ symbol, change: Number(change) })}>
          {working && <LoaderGlyph />}
          Apply
        </Button>
        <Button size="sm" variant="ghost" disabled={working || applied.length === 0} onClick={() => void send({ reset: true })}>
          Reset prices
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {applied.length > 0
          ? `Prices moved: ${applied.map(([ticker, factor]) => `${ticker} ${factor > 1 ? "+" : "−"}${Math.round(Math.abs(factor - 1) * 100)}%`).join(", ")}. `
          : "Demo quotes are fixed, so this scales one ticker's price to show drift. "}
        Nothing is sent to a brokerage.
      </p>
      {error && (
        <p role="alert" className="text-xs text-negative-subtle-foreground">
          {error}
        </p>
      )}
    </fieldset>
  );
}
