"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { BasketExecution } from "@/components/execution/basket-execution";
import { PreflightDialog, type BasketAction } from "@/components/execution/preflight-dialog";
import {
  deltaTone,
  formatMoney,
  formatMoneyDelta,
  formatPercent,
  formatPercentDelta,
  formatPoints,
  formatTimestamp,
  formatUnits,
} from "@/components/portfolio/format";
import { DriftBar } from "@/components/theses/drift-bar";
import { SimulateMove } from "@/components/theses/simulate-move";
import { Badge, type badgeVariants } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { ThesisCard as ThesisCardData, ThesisLine, ThesisValuation } from "@/lib/theses/types";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

type Tone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

const RISK_TONE: Record<ThesisCardData["riskProfile"], Tone> = {
  conservative: "neutral",
  moderate: "neutral",
  aggressive: "warning",
  speculative: "warning",
};

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium tabular-nums", tone)}>{value}</dd>
    </div>
  );
}

function Valuation({ card, valuation }: { card: ThesisCardData; valuation: ThesisValuation }) {
  const { currency } = card;
  const closed = card.status === "closed";
  return (
    <section aria-label="Valuation" className="flex flex-col gap-4 rounded-md bg-surface-sunken p-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex flex-col gap-1">
          <p className="eyebrow text-muted-foreground">► {closed ? "Final result" : "Value now"} · {currency}</p>
          <p className="font-display text-2xl font-semibold tabular-nums">{formatMoney(valuation.totalValue, currency)}</p>
        </div>
        <p className={cn("text-right text-sm font-medium tabular-nums", deltaTone(valuation.totalReturn))}>
          {formatMoneyDelta(valuation.totalReturn, currency)}
          <span className="block text-xs font-normal">
            {formatPercentDelta(valuation.totalReturnPct)} on {formatMoney(valuation.contributed, currency)} in
          </span>
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Figure label="Holdings" value={formatMoney(valuation.holdingsValue, currency)} />
        <Figure label="Cost basis" value={formatMoney(valuation.costBasis, currency)} />
        <Figure
          label="Unrealized"
          value={formatMoneyDelta(valuation.unrealized, currency)}
          tone={deltaTone(valuation.unrealized)}
        />
        <Figure
          label={valuation.cash > 0 || valuation.realized !== 0 ? "Cash · realized" : "Cash"}
          value={
            valuation.realized !== 0
              ? `${formatMoney(valuation.cash, currency)} · ${formatMoneyDelta(valuation.realized, currency)}`
              : formatMoney(valuation.cash, currency)
          }
        />
      </dl>
    </section>
  );
}

function LineRow({ line, scale, currency, flagged }: { line: ThesisLine; scale: number; currency: string; flagged: boolean }) {
  const past = flagged && Math.abs(line.drift) > 0.05 - 1e-9;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2.5 py-3">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
        <span className="font-mono font-medium">{line.symbol}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {line.companyName} · {formatUnits(line.units)} {line.units === 1 ? "share" : "shares"}
        </span>
      </div>
      <div className="order-last flex w-full flex-col gap-1 sm:order-none sm:w-auto sm:flex-1">
        <DriftBar symbol={line.symbol} current={line.currentWeight} target={line.targetWeight} scale={scale} />
        <p className="text-xs text-muted-foreground tabular-nums sm:hidden">
          {formatPercent(line.currentWeight)} now · {formatPercent(line.targetWeight)} target
        </p>
      </div>
      <div className="hidden w-28 text-right text-xs text-muted-foreground tabular-nums sm:block">
        {formatPercent(line.currentWeight)}
        <span className="block">of {formatPercent(line.targetWeight)}</span>
      </div>
      <div className="w-28 text-right tabular-nums">
        <span className="font-medium">{formatMoney(line.value, currency)}</span>
        <span className={cn("block text-xs", deltaTone(line.unrealized))}>{formatMoneyDelta(line.unrealized, currency)}</span>
      </div>
      <div
        className={cn(
          "w-20 text-right text-sm font-medium tabular-nums",
          past ? "text-warning-subtle-foreground" : "text-muted-foreground",
        )}
      >
        {formatPoints(line.drift)}
      </div>
    </li>
  );
}

function Lines({ card, valuation }: { card: ThesisCardData; valuation: ThesisValuation }) {
  const held = valuation.lines.filter((line) => line.units > 0 || card.status !== "closed");
  const scale = Math.max(0.1, ...held.map((line) => Math.max(line.currentWeight, line.targetWeight))) * 1.15;
  return (
    <section aria-label="Drift by stock" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow text-muted-foreground">► Drift from target</p>
        <p className="text-xs text-muted-foreground">
          Flagged past ±{Math.round(valuation.threshold * 100)} pts · largest now {formatPoints(valuation.maxAbsDrift).replace("+", "")}
        </p>
      </div>
      <ul className="divide-y">
        {held.map((line) => (
          <LineRow
            key={line.symbol}
            line={line}
            scale={scale}
            currency={card.currency}
            flagged={valuation.rebalanceRecommended}
          />
        ))}
      </ul>
    </section>
  );
}

export function ThesisCard({ card, demo }: { card: ThesisCardData; demo: boolean }) {
  const router = useRouter();
  const [action, setAction] = useState<BasketAction | null>(null);
  const [open, setOpen] = useState(false);
  const { valuation } = card;
  const closed = card.status === "closed";
  const flagged = Boolean(valuation?.rebalanceRecommended) && card.status === "active";
  const busy = Boolean(card.execution);

  const start = useCallback(
    (kind: BasketAction["kind"]) => {
      setAction({ kind, basketId: card.id });
      setOpen(true);
    },
    [card.id],
  );
  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) router.refresh();
    },
    [router],
  );
  const noop = useCallback(() => undefined, []);

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1">
            <p className="eyebrow text-muted-foreground">► Thesis</p>
            <CardTitle className="font-display text-xl font-semibold">{card.title}</CardTitle>
          </div>
          <div className="flex flex-wrap gap-1">
            {flagged && (
              <Badge tone="warning" dot>
                Rebalance recommended
              </Badge>
            )}
            {card.mode === "live" ? (
              <Badge tone="solid" dot>
                Live
              </Badge>
            ) : (
              <Badge tone="info">Paper</Badge>
            )}
            {card.status !== "active" && (
              <Badge tone={card.status === "deploying" ? "warning" : "neutral"} dot={card.status === "deploying"}>
                {closed ? "Closed" : "Deploying"}
              </Badge>
            )}
            <Badge tone={RISK_TONE[card.riskProfile]}>{card.riskProfile} risk</Badge>
            <Badge>
              {card.currency} · {card.accountName}
            </Badge>
          </div>
        </div>
        <CardDescription className="max-w-prose text-pretty text-foreground">{card.summary}</CardDescription>
        <p className="text-xs text-muted-foreground">
          {card.institution} · {closed ? `closed ${formatTimestamp(card.closedAt)}` : `first fill ${formatTimestamp(card.deployedAt)}`}
          {card.pricing.asOf && !closed && (
            <>
              {" "}
              · {card.pricing.source === "demo" ? "fictional demo quotes" : "SnapTrade quotes"} as of{" "}
              {formatTimestamp(card.pricing.asOf)}
            </>
          )}
        </p>
        {card.pricing.problem && (
          <p role="status" className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground">
            {card.pricing.problem}
          </p>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {valuation ? (
          <>
            <Valuation card={card} valuation={valuation} />
            {!closed && <Lines card={card} valuation={valuation} />}
          </>
        ) : (
          <p className="rounded-md bg-surface-sunken p-4 text-sm text-muted-foreground">
            {card.status === "deploying"
              ? "The deploy run is still filling legs. Valuation starts when the first leg fills."
              : "Prices aren't available for this basket right now, so there's no valuation to show."}
          </p>
        )}

        {card.execution && !open && (
          <section aria-label="Rebalance or close run" className="flex flex-col gap-3 rounded-md border p-4">
            <p className="eyebrow text-muted-foreground">
              ► {card.execution.kind === "close" ? "Closing" : "Rebalancing"} · paper run
            </p>
            <BasketExecution execution={card.execution} />
          </section>
        )}

        {demo && card.status === "active" && valuation && (
          <SimulateMove basketId={card.id} symbols={valuation.lines.map((line) => line.symbol)} moves={card.simulatedMoves} />
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-surface-sunken py-4">
        <Link href={card.basketPath} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          Open basket record
        </Link>
        {card.status === "active" && (
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" className="border-destructive" disabled={busy} onClick={() => start("close")}>
              Close basket
            </Button>
            <Button variant={flagged ? "brand" : "outline"} disabled={busy || !valuation} onClick={() => start("rebalance")}>
              {flagged ? "Rebalance" : "Rebalance anyway"}
            </Button>
          </div>
        )}
      </CardFooter>

      <PreflightDialog open={open} onOpenChange={onOpenChange} endpoint="" request={action} onExecuted={noop} />
    </Card>
  );
}
