"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ExecutionLoader } from "@/components/execution/execution-loader";
import { ExecutionPanel, type ExecutionState } from "@/components/execution/execution-panel";
import { Loader, LoaderGlyph } from "@/components/loader/loader";
import { LinkPendingStatus } from "@/components/loader/pending";
import { formatMoney, formatTimestamp } from "@/components/portfolio/format";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogSection, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import type {
  ExecutionErrorBody,
  ExecutionKind,
  ExecutionMode,
  ExecutionView,
  PreflightPayload,
  PreflightRequest,
} from "@/lib/execution/types";

type Phase = "loading" | "error" | "ready" | "confirming" | "running";

const FIELD =
  "rounded-md border border-input bg-card px-2 py-1 text-base text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-50 md:text-sm";

async function readJson<T>(response: Response): Promise<T | ExecutionErrorBody | null> {
  return (await response.json().catch(() => null)) as T | ExecutionErrorBody | null;
}

const failure = (body: unknown, status: number) =>
  body && typeof body === "object" && "error" in body
    ? (body as ExecutionErrorBody).error
    : { code: "http_error", message: `Request failed (HTTP ${status}). Try again.` };

/** A rebalance or close of a saved basket; a deploy is the default and needs no description. */
export type BasketAction = { kind: "rebalance" | "close"; basketId: string };

const pts = (fraction: number) => `${(Math.abs(fraction) * 100).toFixed(1)} pts`;

type PreflightResult = { ok: true; preflight: PreflightPayload } | { ok: false; message: string };

async function fetchPreflight(
  endpoint: string,
  request: PreflightRequest | BasketAction,
  basketId: string | null,
): Promise<PreflightResult> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, basketId }),
    });
    const body = await readJson<PreflightPayload>(response);
    if (!response.ok || !body || "error" in body) return { ok: false, message: failure(body, response.status).message };
    return { ok: true, preflight: body };
  } catch {
    return { ok: false, message: "Couldn't reach ThesisDeploy. Check your connection and try again." };
  }
}

const BASIS_LABEL = { ask: "ask", bid: "bid", last: "last trade" } as const;

function OrderTable({ preflight }: { preflight: PreflightPayload }) {
  const { currency, totals } = preflight;
  const trades = preflight.kind === "rebalance" || preflight.kind === "close";
  return (
    <table className="w-full font-mono text-xs">
      <caption className="sr-only">Orders to submit, in order</caption>
      <thead>
        <tr className="border-b border-border-strong text-left">
          <th scope="col" className="eyebrow w-8 py-2 font-medium text-muted-foreground">
            #
          </th>
          <th scope="col" className="eyebrow py-2 font-medium text-muted-foreground">
            Order
          </th>
          <th scope="col" className="eyebrow hidden py-2 text-right font-medium text-muted-foreground sm:table-cell">
            Price
          </th>
          <th scope="col" className="eyebrow py-2 text-right font-medium text-muted-foreground">
            {trades ? "Est. value" : "Est. cost"}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {preflight.orders.map((order) => (
          <tr key={order.seq}>
            <td className="py-2.5 align-top text-muted-foreground tabular-nums">{order.seq}</td>
            <td className="py-2.5 align-top">
              <span>
                {order.action} {order.units} <span className="font-medium">{order.symbol}</span> @ MKT
              </span>
              <span className="block font-sans text-muted-foreground">
                {order.companyName}
                <span className="sm:hidden tabular-nums"> · {formatMoney(order.price, currency)}</span>
              </span>
            </td>
            <td className="hidden py-2.5 text-right align-top tabular-nums sm:table-cell">
              {formatMoney(order.price, currency)}
              <span className="block text-muted-foreground">{BASIS_LABEL[order.priceBasis]}</span>
            </td>
            <td className="py-2.5 text-right align-top font-medium tabular-nums">{formatMoney(order.estCost, currency)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        {trades ? (
          <>
            <tr className="border-t border-border-strong">
              <td colSpan={2} className="py-2 font-sans text-sm text-muted-foreground">
                Sells raise
              </td>
              <td className="hidden sm:table-cell" />
              <td className="py-2 text-right text-sm tabular-nums">{formatMoney(totals.sellProceeds ?? 0, currency)}</td>
            </tr>
            <tr>
              <td colSpan={2} className="py-2 font-sans text-sm text-muted-foreground">
                Buys spend
              </td>
              <td className="hidden sm:table-cell" />
              <td className="py-2 text-right text-sm tabular-nums">{formatMoney(totals.estCost, currency)}</td>
            </tr>
          </>
        ) : (
          <tr className="border-t border-border-strong">
            <td colSpan={2} className="py-2.5 font-sans text-sm font-medium">
              Estimated total
            </td>
            <td className="hidden sm:table-cell" />
            <td className="py-2.5 text-right text-sm font-medium tabular-nums">{formatMoney(totals.estCost, currency)}</td>
          </tr>
        )}
      </tfoot>
    </table>
  );
}

const RUN_LABEL: Record<
  ExecutionKind,
  { eyebrow: string; run: Record<ExecutionMode, string>; confirm: string; button: string; live: (count: number) => string }
> = {
  deploy: {
    eyebrow: "Pre-flight",
    run: { paper: "Paper run", live: "Live run" },
    confirm: "Confirm",
    button: "Run paper simulation",
    live: (count) => `Submit ${count} live ${count === 1 ? "order" : "orders"}`,
  },
  rebalance: {
    eyebrow: "Rebalance pre-flight",
    run: { paper: "Paper rebalance", live: "Live rebalance" },
    confirm: "Rebalance",
    button: "Run paper rebalance",
    live: (count) => `Submit live rebalance · ${count} ${count === 1 ? "order" : "orders"}`,
  },
  close: {
    eyebrow: "Close pre-flight",
    run: { paper: "Paper close", live: "Live close" },
    confirm: "Close basket",
    button: "Sell everything and close",
    live: (count) => `Sell everything live · ${count} ${count === 1 ? "order" : "orders"}`,
  },
};

type ImpactState = { phase: "idle" | "checking" | "error"; error: string | null };

function ImpactSummary({ preflight, impact }: { preflight: PreflightPayload; impact: ImpactState }) {
  const { currency } = preflight;
  const institution = preflight.account.institution;
  const result = preflight.impact;
  const value = (amount: number | null | undefined) =>
    amount == null ? <span className="text-muted-foreground">Not available</span> : formatMoney(amount, currency);
  if (impact.phase === "checking") {
    return (
      <Loader
        variant="scan"
        size="inline"
        delayMs={0}
        label={`Asking ${institution} to preview ${preflight.orders.length} ${preflight.orders.length === 1 ? "order" : "orders"}…`}
      />
    );
  }
  if (!result) {
    return impact.error ? <p className="text-xs text-negative-subtle-foreground">{impact.error}</p> : null;
  }
  const previewed = result.legs.filter((leg) => leg.status === "ok").length;
  const source =
    result.source === "brokerage"
      ? "Brokerage preview"
      : result.source === "unsupported"
        ? "Not available"
        : `Brokerage preview for ${previewed} of ${result.legs.length} orders`;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <p>
        <span className="font-medium">Impact source: {source}</span>
        {result.source === "unsupported" && ` (${institution} has no order preview through SnapTrade)`}
      </p>
      <dl className="grid grid-cols-(--grid-card-header) gap-x-4 gap-y-1 tabular-nums">
        <dt className="text-muted-foreground">Estimated commissions</dt>
        <dd className="text-right">{value(result.totalCommission)}</dd>
        <dt className="text-muted-foreground">Foreign-exchange fees</dt>
        <dd className="text-right">{value(result.totalForexFees)}</dd>
        <dt className="text-muted-foreground">Cash after these orders ({institution} estimate)</dt>
        <dd className="text-right">{value(result.remainingCash)}</dd>
      </dl>
      {result.source !== "brokerage" && (
        <p className="text-muted-foreground">
          Order impact unavailable. A reliable pre-trade impact or fee estimate is not available for{" "}
          {result.source === "unsupported" ? "these orders" : "some of these orders"}. The final execution price, transaction
          amount, commissions, fees, and cash impact may not be known until the order is submitted or executed. Fees may apply.
          By submitting, you agree to proceed without these estimates.
        </p>
      )}
    </div>
  );
}

function LiveSection({
  preflight,
  impact,
  onPreview,
  acknowledged,
  setAcknowledged,
}: {
  preflight: PreflightPayload;
  impact: ImpactState;
  onPreview: () => void;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
}) {
  const { account } = preflight;
  const count = preflight.orders.length;
  return (
    <div className="flex flex-col gap-3">
      <div className="dark flex flex-col gap-1 rounded-md bg-background px-4 py-3 text-foreground">
        <p className="eyebrow flex items-center gap-2 text-muted-foreground">
          <Badge tone="solid" dot>
            Live
          </Badge>
          Real market orders
        </p>
        <p className="text-sm">
          Sends {count} whole-share market {count === 1 ? "order" : "orders"} to {account.name} at {account.institution}
          {account.isPaper ? ", a paper-trading account" : ""}, one per second. They can&apos;t be canceled from ThesisDeploy.
        </p>
      </div>
      {(preflight.live.notes ?? []).map((note) => (
        <p
          key={note}
          className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2.5 text-xs text-warning-subtle-foreground"
        >
          {note}
        </p>
      ))}
      <ImpactSummary preflight={preflight} impact={impact} />
      {impact.phase === "error" && (
        <Button variant="outline" size="sm" className="self-start" onClick={onPreview}>
          Try the brokerage preview again
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        Order values above: Application-generated estimate. This application calculated these amounts using the latest
        available quote. They were not supplied or verified by SnapTrade or the brokerage.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4 accent-brand"
          checked={acknowledged}
          disabled={!preflight.impact}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>
          I understand these are real market orders on my {account.institution} account, filled at the next available
          price, and that ThesisDeploy can&apos;t undo them.
        </span>
      </label>
    </div>
  );
}

function PreflightBody({
  preflight,
  mode,
  setMode,
  rejectSeq,
  setRejectSeq,
  live,
}: {
  preflight: PreflightPayload;
  mode: ExecutionMode;
  setMode: (mode: ExecutionMode) => void;
  rejectSeq: number | null;
  setRejectSeq: (seq: number | null) => void;
  live: Omit<Parameters<typeof LiveSection>[0], "preflight">;
}) {
  const paperGate = preflight.paper ?? { available: true, reasons: [] };
  const { currency, totals } = preflight;
  return (
    <DialogSection className="flex flex-col gap-5 pb-6">
      {preflight.rebalance && (
        <p className="rounded-md bg-surface-sunken px-3 py-2.5 text-sm tabular-nums">
          Largest drift {pts(preflight.rebalance.maxDriftBefore)} → about {pts(preflight.rebalance.maxDriftAfter)} after these
          trades.
        </p>
      )}
      <OrderTable preflight={preflight} />
      <p className="text-xs text-muted-foreground">
        {preflight.kind === "rebalance" ? (
          <>
            {formatMoney(totals.unallocated, currency)} left over after whole shares
          </>
        ) : preflight.kind === "close" ? (
          <>Sells every share in the basket at the {preflight.market.open ? "bid" : "last trade"}</>
        ) : (
          <>
            Budget {formatMoney(preflight.budget, currency)} ·{" "}
            {totals.overBudget ? (
              <span className="text-negative-subtle-foreground">
                {formatMoney(-totals.unallocated, currency)} over budget at these prices
              </span>
            ) : (
              <>{formatMoney(totals.unallocated, currency)} stays in cash</>
            )}
          </>
        )}
        {preflight.leftOut.length > 0 && (
          <>
            {" "}
            · Not ordered:{" "}
            {preflight.leftOut.map((line, i) => (
              <span key={line.symbol}>
                {i > 0 && ", "}
                <span className="font-mono">{line.symbol}</span> ({line.reason})
              </span>
            ))}
          </>
        )}
      </p>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>{preflight.market.note}</p>
        <p>
          Prices: {preflight.impactNote} Quoted {formatTimestamp(preflight.preparedAt)}; valid for 5 minutes.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Execution mode</span>
        <Segmented
          name="Execution mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "paper", label: "Paper simulation", disabled: !paperGate.available },
            { value: "live", label: "Live brokerage", disabled: !preflight.live.available && mode !== "live" },
          ]}
        />
        {!preflight.live.available && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p className="flex items-center gap-2">
              <Badge tone="solid">Live</Badge> is unavailable:
            </p>
            <ul className="flex list-disc flex-col gap-0.5 pl-5">
              {preflight.live.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {!paperGate.available && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p className="flex items-center gap-2">
              <Badge tone="info">Paper</Badge> is unavailable:
            </p>
            <ul className="flex list-disc flex-col gap-0.5 pl-5">
              {paperGate.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {mode === "live" && <LiveSection preflight={preflight} {...live} />}

      {mode === "paper" && preflight.orders.length > 0 && (
        <fieldset className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong p-3">
          <legend className="eyebrow px-1 text-muted-foreground">Reviewer tools · Paper only</legend>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-brand"
              checked={rejectSeq != null}
              onChange={(event) => setRejectSeq(event.target.checked ? Math.min(2, preflight.orders.length) : null)}
            />
            Simulate a broker rejection on leg
            <select
              aria-label="Leg to reject"
              className={FIELD}
              disabled={rejectSeq == null}
              value={rejectSeq ?? Math.min(2, preflight.orders.length)}
              onChange={(event) => setRejectSeq(Number(event.target.value))}
            >
              {preflight.orders.map((order) => (
                <option key={order.seq} value={order.seq}>
                  {order.seq} · {order.symbol}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            The queue records the rejection, carries on with the other legs, and offers “Retry failed leg”.
          </p>
        </fieldset>
      )}

      <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        {preflight.disclosures[mode].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </DialogSection>
  );
}

/**
 * Loads pre-flight when mounted, then confirms it with an Idempotency-Key that
 * is fixed per pre-flight, so a double click or a retried request can't create
 * a second execution.
 */
function PreflightFlow({
  endpoint,
  request,
  onRunState,
  onExecuted,
}: {
  endpoint: string;
  request: PreflightRequest | BasketAction;
  onRunState: (state: ExecutionState) => void;
  onExecuted: (basketPath: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [preflight, setPreflight] = useState<PreflightPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<ExecutionMode>("paper");
  const [rejectSeq, setRejectSeq] = useState<number | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [execution, setExecution] = useState<ExecutionView | null>(null);
  const [impact, setImpact] = useState<ImpactState>({ phase: "idle", error: null });
  const [acknowledged, setAcknowledged] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  /** Asks the broker to preview every leg; the result is saved on the pre-flight and returned with it. */
  const preview = useCallback(async (target: PreflightPayload) => {
    setImpact({ phase: "checking", error: null });
    try {
      const response = await fetch(`/api/baskets/${target.basketId}/impact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: target.kind ?? "deploy", preflightId: target.preflightId ?? null }),
      });
      const body = await readJson<PreflightPayload>(response);
      if (!response.ok || !body || "error" in body) {
        setImpact({ phase: "error", error: failure(body, response.status).message });
        return;
      }
      setPreflight(body);
      setImpact({ phase: "idle", error: null });
    } catch {
      setImpact({ phase: "error", error: "Couldn't reach ThesisDeploy for the brokerage preview. Try again." });
    }
  }, []);

  const apply = useCallback(
    (result: PreflightResult) => {
      if (!result.ok) {
        setError(result.message);
        setPhase("error");
        return;
      }
      const next = result.preflight;
      // A Live basket is rebalanced and closed only Live.
      const liveOnly = next.paper?.available === false;
      setPreflight(next);
      setMode(liveOnly ? "live" : "paper");
      setAcknowledged(false);
      setImpact({ phase: "idle", error: null });
      setIdempotencyKey(crypto.randomUUID());
      setError(null);
      setPhase("ready");
      if (liveOnly && next.live.available && !next.impact) void preview(next);
    },
    [preview],
  );

  const chooseMode = (next: ExecutionMode) => {
    setMode(next);
    setAcknowledged(false);
    if (next === "live" && preflight && preflight.live.available && !preflight.impact && impact.phase !== "checking") {
      void preview(preflight);
    }
  };

  const load = useCallback(
    async (basketId: string | null) => apply(await fetchPreflight(endpoint, request, basketId)),
    [apply, endpoint, request],
  );

  useEffect(() => {
    let current = true;
    void fetchPreflight(endpoint, request, null).then((result) => {
      if (current) apply(result);
    });
    return () => {
      current = false;
    };
  }, [apply, endpoint, request]);

  async function confirm() {
    if (!preflight) return;
    setPhase("confirming");
    setError(null);
    try {
      const response = await fetch("/api/executions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          basketId: preflight.basketId,
          kind: preflight.kind ?? "deploy",
          preflightId: preflight.preflightId ?? null,
          mode,
          simulateRejectSeq: mode === "paper" ? rejectSeq : null,
          acknowledgeLive: mode === "live" && acknowledged,
        }),
      });
      const body = await readJson<ExecutionView>(response);
      if (!response.ok || !body || "error" in body) {
        const { code, message } = failure(body, response.status);
        if (code === "preflight_stale") {
          setNotice("Those prices were out of date, so pre-flight ran again. Check the orders and confirm.");
          setPhase("loading");
          await load(preflight.basketId);
          return;
        }
        if (code === "impact_required") {
          setPhase("ready");
          void preview(preflight);
          return;
        }
        setError(message);
        setPhase("ready");
        return;
      }
      setExecution(body);
      setPhase("running");
      onExecuted(body.basketPath);
      // The run starts at the top of the dialog, wherever pre-flight was scrolled to.
      requestAnimationFrame(() => top.current?.scrollIntoView({ block: "start" }));
    } catch {
      setError("Couldn't reach ThesisDeploy. Your confirmation is safe to retry.");
      setPhase("ready");
    }
  }

  const count = preflight?.orders.length ?? 0;
  const kind: ExecutionKind = preflight?.kind ?? ("kind" in request ? request.kind : "deploy");
  const label = RUN_LABEL[kind];
  const runMode = execution?.mode ?? mode;
  const canSubmitLive =
    phase === "ready" && Boolean(preflight?.live.available) && Boolean(preflight?.impact) && impact.phase !== "checking" && acknowledged;
  return (
    <>
      <DialogSection ref={top} className="flex flex-col gap-1 pt-6 pb-4">
        <p className="eyebrow flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>
            ► {execution ? label.run[runMode] : label.eyebrow}
            {preflight && ` · ${preflight.account.name}`}
          </span>
          {preflight &&
            (runMode === "live" ? (
              <Badge tone="solid" dot>
                Live
              </Badge>
            ) : (
              <Badge tone="info">Paper</Badge>
            ))}
        </p>
        <DialogTitle>
          {execution
            ? preflight?.title
            : preflight
              ? `${label.confirm} · ${count} ${count === 1 ? "order" : "orders"}`
              : "Pre-flight check"}
        </DialogTitle>
        <DialogDescription>
          {execution
            ? "Each leg is submitted one second apart. A failed leg doesn't stop the queue."
            : preflight
              ? `${preflight.title}: whole-share market orders in ${preflight.currency}${
                  kind === "deploy" ? ", priced just now." : ", sells first, priced just now."
                }`
              : "Re-checking prices, market hours, and the account before anything is submitted."}
        </DialogDescription>
      </DialogSection>

      {notice && phase !== "running" && (
        <DialogSection className="pb-4">
          <p role="status" className="rounded-md border border-info-border bg-info-subtle px-3 py-2.5 text-xs text-info-subtle-foreground">
            {notice}
          </p>
        </DialogSection>
      )}

      {phase === "loading" && (
        <DialogSection className="pb-6">
          <ExecutionLoader
            label="Pricing the orders…"
            legs={
              "lines" in request
                ? request.lines.filter((line) => line.units > 0).map((line) => ({ symbol: line.symbol, shares: line.units, status: "queued" }))
                : undefined
            }
          />
        </DialogSection>
      )}

      {execution ? (
        <DialogSection className="pb-6">
          <ExecutionPanel
            initial={execution}
            autoResume
            onStateChange={onRunState}
            actions={
              <>
                <DialogClose render={<Button variant="outline" size="sm" />}>Close</DialogClose>
                <Link href={execution.basketPath} className={buttonVariants({ size: "sm" })}>
                  View saved basket
                  <LinkPendingStatus variant="stacks" label="Opening the saved basket…" />
                </Link>
              </>
            }
          />
        </DialogSection>
      ) : (
        preflight &&
        phase !== "loading" && (
          <PreflightBody
            preflight={preflight}
            mode={mode}
            setMode={chooseMode}
            rejectSeq={rejectSeq}
            setRejectSeq={setRejectSeq}
            live={{ impact, onPreview: () => void preview(preflight), acknowledged, setAcknowledged }}
          />
        )
      )}

      {!execution && (
        <div className="sticky bottom-0 flex flex-col gap-3 border-t bg-surface-sunken px-6 py-4">
          {error && (
            <p
              role="alert"
              className="rounded-md border border-negative-border bg-negative-subtle px-3 py-2.5 text-xs text-negative-subtle-foreground"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            {phase === "error" ? (
              <Button
                onClick={() => {
                  setPhase("loading");
                  void load(preflight?.basketId ?? null);
                }}
              >
                Try again
              </Button>
            ) : mode === "live" ? (
              <Button variant="brand" disabled={!canSubmitLive} onClick={() => void confirm()}>
                {phase === "confirming" && <LoaderGlyph variant="stacks" />}
                {phase === "confirming" ? "Sending…" : label.live(count)}
              </Button>
            ) : (
              <Button
                variant={kind === "close" ? "destructive" : "default"}
                className={kind === "close" ? "border-destructive" : undefined}
                disabled={phase !== "ready" || count === 0}
                onClick={() => void confirm()}
              >
                {phase === "confirming" && <LoaderGlyph variant="stacks" />}
                {phase === "confirming" ? "Starting…" : label.button}
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function PreflightDialog({
  open,
  onOpenChange,
  endpoint,
  request,
  onExecuted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The deploy pre-flight route; rebalance and close use the basket's own. */
  endpoint: string;
  request: PreflightRequest | BasketAction | null;
  onExecuted: (basketPath: string) => void;
}) {
  const [run, setRun] = useState<ExecutionState | null>(null);
  const submitting = run?.draining ?? false;
  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(next, details) => {
        // Esc and Close are ignored while legs are being submitted.
        if (!next && submitting) return details.cancel();
        if (!next) setRun(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        {open && request && (
          <PreflightFlow
            endpoint={"kind" in request ? `/api/baskets/${request.basketId}/preflight` : endpoint}
            request={request}
            onRunState={setRun}
            onExecuted={onExecuted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
