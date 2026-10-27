import Link from "next/link";

import { BasketExecution } from "@/components/execution/basket-execution";
import { formatMoney, formatMoneyDelta, formatPercent, formatTimestamp } from "@/components/portfolio/format";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { BasketView } from "@/lib/execution/types";
import { cn } from "@/lib/utils";

const STATUS: Record<BasketView["status"], { tone: "neutral" | "warning" | "positive"; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  deploying: { tone: "warning", label: "Deploying" },
  active: { tone: "positive", label: "Active" },
  closed: { tone: "neutral", label: "Closed" },
};

/** The Virtual Basket record: what was confirmed, what filled, and the execution that filled it. */
export function BasketRecord({
  basket,
  studioPath,
  thesesPath,
}: {
  basket: BasketView;
  studioPath: string;
  thesesPath: string;
}) {
  const { currency } = basket;
  const held = basket.constituents.reduce((sum, row) => sum + row.costTotal, 0);
  const realized = basket.constituents.reduce((sum, row) => sum + row.realizedTotal, 0);
  const filledNames = basket.constituents.filter((row) => row.ledgerUnits > 0).length;
  const status = STATUS[basket.status];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="flex flex-col gap-1">
              <p className="eyebrow text-muted-foreground">► Virtual basket</p>
              <CardTitle className="font-display text-xl font-semibold">{basket.title}</CardTitle>
            </div>
            <div className="flex flex-wrap gap-1">
              {basket.mode === "live" ? (
                <Badge tone="solid" dot>
                  Live
                </Badge>
              ) : (
                <Badge tone="info">Paper</Badge>
              )}
              <Badge tone={status.tone} dot={basket.status === "deploying"}>
                {status.label}
              </Badge>
              <Badge>
                {currency} · {basket.account.name}
              </Badge>
            </div>
          </div>
          <CardDescription className="max-w-prose text-pretty text-foreground">{basket.summary}</CardDescription>
          <p className="text-xs text-muted-foreground">
            {basket.account.institution} · created {formatTimestamp(basket.createdAt)}
            {basket.deployedAt && <> · first fill {formatTimestamp(basket.deployedAt)}</>}
            {basket.closedAt && <> · closed {formatTimestamp(basket.closedAt)}</>}. Paper fills use the
            pre-flight {basket.priceSource === "demo" ? "fictional demo quotes" : "SnapTrade quotes"}; the shares don&apos;t
            exist at the brokerage and are kept apart from real holdings.
          </p>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          <section aria-label="Ledger" className="flex flex-col gap-2 rounded-md bg-surface-sunken p-4">
            <p className="eyebrow text-muted-foreground">► Ledger · {currency}</p>
            <p className="font-display text-2xl font-semibold tabular-nums">
              {formatMoney(held, currency)} held at cost · {filledNames} of {basket.constituents.length} names held
            </p>
            <p className="text-xs text-muted-foreground">
              {formatMoney(basket.contributed, currency)} put in from a {formatMoney(basket.budget, currency)} budget
              {basket.cash !== 0 && <> · {formatMoney(basket.cash, currency)} cash from sales</>}
              {realized !== 0 && <> · {formatMoneyDelta(realized, currency)} realized</>}. The ledger changes only when a leg
              fills.
            </p>
          </section>

          <table className="w-full text-sm">
            <caption className="sr-only">Constituents and holdings</caption>
            <thead>
              <tr className="border-b border-border-strong text-left">
                <th scope="col" className="eyebrow py-2 font-medium text-muted-foreground">
                  Symbol
                </th>
                <th scope="col" className="eyebrow hidden py-2 text-right font-medium text-muted-foreground sm:table-cell">
                  Target
                </th>
                <th scope="col" className="eyebrow hidden py-2 text-right font-medium text-muted-foreground sm:table-cell">
                  Planned
                </th>
                <th scope="col" className="eyebrow py-2 text-right font-medium text-muted-foreground">
                  Held
                </th>
                <th scope="col" className="eyebrow hidden py-2 text-right font-medium text-muted-foreground sm:table-cell">
                  Avg cost
                </th>
                <th scope="col" className="eyebrow py-2 text-right font-medium text-muted-foreground">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {basket.constituents.map((row) => (
                <tr key={row.symbol} className="transition-colors hover:bg-surface-sunken">
                  <td className="py-3">
                    <span className="font-mono font-medium">{row.symbol}</span>
                    <span className="block text-xs text-muted-foreground">{row.companyName}</span>
                  </td>
                  <td className="hidden py-3 text-right tabular-nums sm:table-cell">{formatPercent(row.targetWeight)}</td>
                  <td className="hidden py-3 text-right tabular-nums sm:table-cell">{row.plannedUnits}</td>
                  <td className="py-3 text-right font-medium tabular-nums">
                    {row.ledgerUnits}
                    <span className="block text-xs font-normal text-muted-foreground sm:hidden">of {row.plannedUnits}</span>
                  </td>
                  <td className="hidden py-3 text-right tabular-nums sm:table-cell">
                    {row.ledgerUnits > 0 ? (
                      formatMoney(row.costTotal / row.ledgerUnits, currency)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-3 text-right font-medium tabular-nums">
                    {row.ledgerUnits > 0 ? formatMoney(row.costTotal, currency) : <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {basket.execution && (
        <Card>
          <CardContent>
            <BasketExecution execution={basket.execution} studioPath={studioPath} />
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        See this basket&apos;s value, drift, and rebalance options in{" "}
        <Link href={thesesPath} className={cn(buttonVariants({ variant: "link", size: "xs" }), "px-0")}>
          My Theses
        </Link>
        .
      </p>
    </div>
  );
}
