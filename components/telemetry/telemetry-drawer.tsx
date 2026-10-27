"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { Loader } from "@/components/loader/loader";
import { formatTimestamp } from "@/components/portfolio/format";
import { dropReason, formatCount, formatMs, formatRate, rate } from "@/components/telemetry/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Segmented } from "@/components/ui/segmented";
import type { FunnelCohort, TelemetryPayload, TelemetrySnapshot, Viewer } from "@/lib/telemetry/types";
import { cn } from "@/lib/utils";

type Scope = "global" | "you";

/** Footer toggle for the Product Telemetry Drawer, on every page. */
export function TelemetryToggle({ className }: { className?: string }) {
  return (
    <Drawer>
      <DrawerTrigger
        className={cn(
          "eyebrow w-fit rounded-sm text-muted-foreground underline-offset-6 transition-colors outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30",
          className,
        )}
      >
        ► Product telemetry
      </DrawerTrigger>
      <DrawerContent>
        <TelemetryPanel />
      </DrawerContent>
    </Drawer>
  );
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: TelemetryPayload };

async function fetchTelemetry(signal: AbortSignal): Promise<{ data: TelemetryPayload } | { error: string }> {
  try {
    const response = await fetch("/api/telemetry", { cache: "no-store", signal });
    const body = (await response.json().catch(() => null)) as TelemetryPayload | { error: { message: string } } | null;
    if (response.ok && body && !("error" in body)) return { data: body };
    return {
      error: body && "error" in body ? body.error.message : `Telemetry couldn't be loaded (HTTP ${response.status}).`,
    };
  } catch {
    return { error: "Couldn't reach ThesisDeploy. Check your connection and try again." };
  }
}

/** Fetched each time the drawer opens; the loader settles before the numbers appear. */
function TelemetryPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [arrived, setArrived] = useState<TelemetryPayload | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scope, setScope] = useState<Scope>("global");

  useEffect(() => {
    const controller = new AbortController();
    void fetchTelemetry(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if ("data" in result) setArrived(result.data);
      else setState({ status: "error", message: result.error });
    });
    return () => controller.abort();
  }, [attempt]);

  const data = state.status === "ready" ? state.data : null;
  const snapshot = data ? (scope === "global" ? data.global : data.you) : null;

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b py-2 pr-3 pl-5 sm:pl-6">
        <p className="eyebrow text-muted-foreground">► Product telemetry</p>
        <DrawerClose render={<Button variant="ghost" size="icon-sm" aria-label="Close telemetry" />}>
          <X />
        </DrawerClose>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-1 px-5 pt-4 pb-3 sm:px-6 sm:pt-5">
          <DrawerTitle className="font-display text-2xl font-semibold">How ThesisDeploy is used</DrawerTitle>
          <DrawerDescription className="text-sm text-muted-foreground">
            The activation funnel, how much people trust Claude&apos;s baskets, and how SnapTrade behaves, from the{" "}
            <code className="font-mono text-xs">events</code> and <code className="font-mono text-xs">api_calls</code>{" "}
            tables.
          </DrawerDescription>
        </div>
        <div className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-card px-5 py-3 sm:px-6">
          <Segmented
            name="Whose activity"
            value={scope}
            options={[
              { value: "global", label: "Everyone" },
              { value: "you", label: "You" },
            ]}
            onChange={setScope}
          />
          <p className="text-xs text-muted-foreground">
            {data ? scopeNote(scope, data.viewer, data.windowDays) : "Last 30 days."}
          </p>
        </div>

        {state.status === "loading" && (
          <Loader
            variant="scan"
            framed={false}
            label="Reading telemetry…"
            detail="Aggregating events and SnapTrade calls."
            settled={arrived != null}
            onSettled={() => {
              if (arrived) setState({ status: "ready", data: arrived });
              setArrived(null);
            }}
          />
        )}

        {state.status === "error" && (
          <div className="flex flex-col items-start gap-3 px-5 py-6 sm:px-6">
            <p
              role="alert"
              className="rounded-md border border-negative-border bg-negative-subtle px-3 py-2.5 text-xs text-negative-subtle-foreground"
            >
              {state.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setState({ status: "loading" });
                setAttempt((count) => count + 1);
              }}
            >
              Try again
            </Button>
          </div>
        )}

        {data && scope === "you" && !snapshot && <NothingYet />}
        {data && snapshot && <Metrics snapshot={snapshot} scope={scope} viewer={data.viewer} />}

        {data && (
          <p className="mt-auto px-5 py-5 text-xs text-muted-foreground sm:px-6">
            Aggregates only. Account IDs are stored as keyed hashes; tokens, codes, and account numbers are never
            logged. Updated {formatTimestamp(data.generatedAt)}; the Everyone view refreshes every minute.
          </p>
        )}
      </div>
    </>
  );
}

function scopeNote(scope: Scope, viewer: Viewer, days: number) {
  if (scope === "global") return `Every signed-in user and demo visitor, last ${days} days.`;
  if (viewer === "user") return `Your SnapTrade sign-in plus this browser's demo activity, last ${days} days.`;
  if (viewer === "guest") return `This browser's demo activity, last ${days} days. Sign in to see your SnapTrade calls.`;
  return `Nothing is tied to this browser yet.`;
}

function NothingYet() {
  return (
    <div className="flex flex-col gap-3 px-5 py-6 text-sm text-muted-foreground sm:px-6">
      <p className="font-display text-xl font-semibold text-foreground">Nothing recorded for you yet.</p>
      <p>
        Generate a basket in the demo Studio or sign in with SnapTrade, then reopen this drawer to see your own funnel,
        edits, and orders next to everyone&apos;s.
      </p>
      <Link
        href="/demo/studio"
        className="eyebrow w-fit rounded-sm text-foreground underline decoration-brand decoration-2 underline-offset-6 outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        ► Open the demo Studio
      </Link>
    </div>
  );
}

function Section({ title, aside, note, children }: { title: string; aside?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b px-5 py-5 sm:px-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="eyebrow text-muted-foreground">► {title}</h3>
        {aside && <span className="text-xs text-muted-foreground tabular-nums">{aside}</span>}
      </div>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}

function Bar({ value }: { value: number | null }) {
  return (
    <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-chart-track">
      <div className="h-full rounded-full bg-brand" style={{ width: `${(value ?? 0) * 100}%` }} />
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Metrics({ snapshot, scope, viewer }: { snapshot: TelemetrySnapshot; scope: Scope; viewer: Viewer }) {
  const { funnel, edits, resolution, orders, latency, rateLimits } = snapshot;
  const showSignedIn = scope === "global" || viewer === "user";
  const showGuest = scope === "global" || funnel.guest.generated > 0 || viewer === "guest";
  const editRate = rate(edits.edited, edits.suggested);
  const guestOnly = scope === "you" && viewer !== "user";

  return (
    <>
      <Section title="Activation funnel" aside="People">
        <div className="flex flex-col gap-5">
          {showSignedIn && <Cohort label="Signed in" cohort={funnel.signedIn} />}
          {showGuest && (
            <Cohort label="Guest demo" cohort={funnel.guest} note="Guests skip sign-in, so they start at Generated." />
          )}
        </div>
      </Section>

      <Section
        title="Basket edit rate"
        note="Suggested tickers removed or resized in the Basket Composer before pre-flight, once per basket; removed then restored doesn't count. Lower means people trust the basket as suggested."
      >
        {edits.suggested === 0 ? (
          <Empty>No baskets generated yet.</Empty>
        ) : (
          <div className="flex items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <p className="font-display text-3xl font-semibold tabular-nums">{formatRate(editRate)}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatCount(edits.edited)} of {formatCount(edits.suggested)} suggested tickers edited
              </p>
            </div>
            <dl className="flex gap-5 text-right">
              <Fact label="Removed" value={edits.removed} />
              <Fact label="Resized" value={edits.resized} />
            </dl>
          </div>
        )}
      </Section>

      <Section
        title="Symbol resolution hit rate"
        note="Tickers Claude proposed that grounding resolved to a tradeable, priced listing in the basket currency, per basket shown."
      >
        {resolution.length === 0 ? (
          <Empty>No baskets generated yet.</Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {resolution.map((row) => {
              const hit = rate(row.resolved, row.proposed);
              return (
                <div key={row.source} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">
                      {row.source === "snaptrade" ? "SnapTrade quotes and symbol search" : "Demo price feed"}
                    </span>
                    <span className="font-display text-xl font-semibold tabular-nums">{formatRate(hit)}</span>
                  </div>
                  <Bar value={hit} />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {formatCount(row.resolved)} of {formatCount(row.proposed)} resolved
                    {row.dropped.map((drop) => ` · ${formatCount(drop.count)} ${dropReason(drop.reason)}`).join("")}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Order success by brokerage"
        note="Every leg attempt is an order, so a retried leg counts twice. Paper fills are simulated at the pre-flight price; demo accounts are fictional."
      >
        {orders.length === 0 ? (
          <Empty>No orders yet. Run a paper execution from a basket&apos;s pre-flight.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-strong">
                <th scope="col" className="eyebrow pb-2 text-left font-medium text-muted-foreground">
                  Brokerage
                </th>
                <th scope="col" className="eyebrow pb-2 text-right font-medium text-muted-foreground">
                  Orders
                </th>
                <th scope="col" className="eyebrow pb-2 text-right font-medium text-muted-foreground">
                  Success
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((row) => (
                <tr key={`${row.brokerage}:${row.mode}`} className="border-b last:border-0">
                  <td className="py-2.5">
                    <span className="flex flex-wrap items-center gap-2">
                      {row.brokerage === "demo" ? (
                        <span>Demo accounts</span>
                      ) : (
                        <span className="font-mono text-xs break-all">{row.brokerage}</span>
                      )}
                      {row.mode === "live" ? (
                        <Badge tone="solid" dot>
                          Live
                        </Badge>
                      ) : (
                        <Badge tone="info">Paper</Badge>
                      )}
                    </span>
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{formatCount(row.orders)}</td>
                  <td className="py-2.5 text-right font-medium tabular-nums">
                    {formatRate(rate(row.succeeded, row.orders))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title="SnapTrade latency"
        note="Every call through the Bearer-only client, failures and timeouts included, since that's the wait people saw."
      >
        {latency.length === 0 ? (
          <Empty>
            {guestOnly
              ? "The demo makes no SnapTrade calls. Switch to Everyone for real calls."
              : "No SnapTrade calls yet."}
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-strong">
                <th scope="col" className="eyebrow pb-2 text-left font-medium text-muted-foreground">
                  Operation
                </th>
                <th scope="col" className="eyebrow pb-2 text-right font-medium text-muted-foreground">
                  Calls
                </th>
                <th scope="col" className="eyebrow pb-2 text-right font-medium text-muted-foreground">
                  p50
                </th>
                <th scope="col" className="eyebrow pb-2 text-right font-medium text-muted-foreground">
                  p95
                </th>
              </tr>
            </thead>
            <tbody>
              {latency.map((row) => (
                <tr key={row.operation} className="border-b last:border-0">
                  <td className="py-2.5 pr-3">
                    <span className="block font-mono text-xs break-all">{row.operation}</span>
                    {row.errors > 0 && (
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatCount(row.errors)} failed
                        {row.rateLimited > 0 && ` · ${formatCount(row.rateLimited)} rate limited`}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 text-right align-top tabular-nums">{formatCount(row.calls)}</td>
                  <td className="py-2.5 pl-3 text-right align-top tabular-nums whitespace-nowrap">{formatMs(row.p50Ms)}</td>
                  <td className="py-2.5 pl-3 text-right align-top font-medium tabular-nums whitespace-nowrap">
                    {formatMs(row.p95Ms)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title="Rate limits (429)"
        note="SnapTrade 429 responses. Account-scoped calls are budgeted below SnapTrade's 10 per minute per account before they're sent, and a 429 is never retried automatically."
      >
        <div className="flex items-end justify-between gap-4">
          <p className="font-display text-3xl font-semibold tabular-nums">{formatCount(rateLimits.count)}</p>
          <p className="text-right text-xs text-muted-foreground tabular-nums">
            {rateLimits.calls === 0 ? (
              guestOnly ? "No SnapTrade calls from the demo" : "No SnapTrade calls yet"
            ) : (
              <>
                of {formatCount(rateLimits.calls)} SnapTrade calls
                <br />
                {rateLimits.lastAt ? `Last ${formatTimestamp(rateLimits.lastAt)}` : "None in this window"}
              </>
            )}
          </p>
        </div>
      </Section>
    </>
  );
}

function Fact({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-semibold tabular-nums">{formatCount(value)}</dd>
    </div>
  );
}

function Cohort({ label, cohort, note }: { label: string; cohort: FunnelCohort; note?: string }) {
  const steps = [
    ...(cohort.connected == null ? [] : [{ label: "Connected", count: cohort.connected, from: null }]),
    { label: "Generated", count: cohort.generated, from: cohort.connected },
    { label: "Deployed", count: cohort.deployed, from: cohort.generated },
  ];
  const top = steps[0].count;
  const endToEnd = rate(cohort.deployed, top);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {endToEnd == null ? "No one yet" : `${formatRate(endToEnd)} end to end`}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {steps.map((step) => {
          const conversion = step.from == null ? null : rate(step.count, step.from);
          return (
            <li
              key={step.label}
              aria-label={`${step.label}: ${step.count} ${step.count === 1 ? "person" : "people"}${
                conversion == null ? "" : `, ${formatRate(conversion)} of the previous step`
              }`}
              className="grid grid-cols-(--grid-funnel) items-center gap-3"
            >
              <span className="text-sm">{step.label}</span>
              <Bar value={rate(step.count, top)} />
              <span className="text-right text-sm font-medium tabular-nums">{formatCount(step.count)}</span>
              <span className="text-right text-xs text-muted-foreground tabular-nums">
                {step.from == null ? "" : formatRate(conversion)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground tabular-nums">
        {formatCount(cohort.baskets.generated)} {cohort.baskets.generated === 1 ? "basket" : "baskets"} generated ·{" "}
        {formatCount(cohort.baskets.deployed)} deployed{note ? `. ${note}` : ""}
      </p>
    </div>
  );
}
