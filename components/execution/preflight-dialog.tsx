"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ExecutionLoader } from "@/components/execution/execution-loader";
import { ExecutionPanel, type ExecutionState } from "@/components/execution/execution-panel";
import { formatMoney, formatTimestamp } from "@/components/portfolio/format";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogSection, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import type {
  ExecutionErrorBody,
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

type PreflightResult = { ok: true; preflight: PreflightPayload } | { ok: false; message: string };

async function fetchPreflight(
  endpoint: string,
  request: PreflightRequest,
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

function OrderTable({ preflight }: { preflight: PreflightPayload }) {
  const { currency } = preflight;
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
            Est. cost
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
              <span className="block text-muted-foreground">{order.priceBasis === "ask" ? "ask" : "last trade"}</span>
            </td>
            <td className="py-2.5 text-right align-top font-medium tabular-nums">{formatMoney(order.estCost, currency)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-border-strong">
          <td colSpan={2} className="py-2.5 font-sans text-sm font-medium">
            Estimated total
          </td>
          <td className="hidden sm:table-cell" />
          <td className="py-2.5 text-right text-sm font-medium tabular-nums">
            {formatMoney(preflight.totals.estCost, currency)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function PreflightBody({
  preflight,
  mode,
  setMode,
  rejectSeq,
  setRejectSeq,
}: {
  preflight: PreflightPayload;
  mode: ExecutionMode;
  setMode: (mode: ExecutionMode) => void;
  rejectSeq: number | null;
  setRejectSeq: (seq: number | null) => void;
}) {
  const { currency, totals } = preflight;
  return (
    <DialogSection className="flex flex-col gap-5 pb-6">
      <OrderTable preflight={preflight} />
      <p className="text-xs text-muted-foreground">
        Budget {formatMoney(preflight.budget, currency)} ·{" "}
        {totals.overBudget ? (
          <span className="text-negative-subtle-foreground">
            {formatMoney(-totals.unallocated, currency)} over budget at these prices
          </span>
        ) : (
          <>{formatMoney(totals.unallocated, currency)} stays in cash</>
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
            { value: "paper", label: "Paper simulation" },
            { value: "live", label: "Live brokerage", disabled: !preflight.live.available },
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
      </div>

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
  request: PreflightRequest;
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

  const apply = useCallback((result: PreflightResult) => {
    if (!result.ok) {
      setError(result.message);
      setPhase("error");
      return;
    }
    setPreflight(result.preflight);
    setIdempotencyKey(crypto.randomUUID());
    setError(null);
    setPhase("ready");
  }, []);

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
        body: JSON.stringify({ basketId: preflight.basketId, mode, simulateRejectSeq: mode === "paper" ? rejectSeq : null }),
      });
      const body = await readJson<ExecutionView>(response);
      if (!response.ok || !body || "error" in body) {
        const { code, message } = failure(body, response.status);
        if (code === "preflight_stale") {
          setNotice("Those prices were more than 5 minutes old, so pre-flight ran again. Check the orders and confirm.");
          setPhase("loading");
          await load(preflight.basketId);
          return;
        }
        setError(message);
        setPhase("ready");
        return;
      }
      setExecution(body);
      setPhase("running");
      onExecuted(body.basketPath);
    } catch {
      setError("Couldn't reach ThesisDeploy. Your confirmation is safe to retry.");
      setPhase("ready");
    }
  }

  const count = preflight?.orders.length ?? 0;
  return (
    <>
      <DialogSection className="flex flex-col gap-1 pt-6 pb-4">
        <p className="eyebrow text-muted-foreground">
          ► {execution ? "Paper run" : "Pre-flight"}
          {preflight && ` · ${preflight.account.name}`}
        </p>
        <DialogTitle>
          {execution
            ? preflight?.title
            : preflight
              ? `Confirm ${count} ${count === 1 ? "order" : "orders"}`
              : "Pre-flight check"}
        </DialogTitle>
        <DialogDescription>
          {execution
            ? "Each leg is submitted one second apart. A failed leg doesn't stop the queue."
            : preflight
              ? `${preflight.title}: whole-share market orders in ${preflight.currency}, priced just now.`
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
          <ExecutionLoader variant="preflight" label="Pricing the orders…" />
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
            setMode={setMode}
            rejectSeq={rejectSeq}
            setRejectSeq={setRejectSeq}
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
              <Button variant="brand" disabled>
                Submit {count} live {count === 1 ? "order" : "orders"}
              </Button>
            ) : (
              <Button disabled={phase !== "ready" || count === 0} onClick={() => void confirm()}>
                {phase === "confirming" ? "Starting…" : "Run paper simulation"}
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
  endpoint: string;
  request: PreflightRequest | null;
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
          <PreflightFlow endpoint={endpoint} request={request} onRunState={setRun} onExecuted={onExecuted} />
        )}
      </DialogContent>
    </Dialog>
  );
}
