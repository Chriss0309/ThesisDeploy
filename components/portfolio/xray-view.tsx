import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, formatPercent, formatTimestamp, formatUnits } from "@/components/portfolio/format";
import { concentrationByCurrency, type CurrencyConcentration } from "@/lib/portfolio/concentration";
import type { SnapshotResult } from "@/lib/portfolio/service";
import type { Capability, PortfolioAccount, PortfolioOverview } from "@/lib/portfolio/types";
import { cn } from "@/lib/utils";

export const SNAPTRADE_DASHBOARD_URL = "https://dashboard.snaptrade.com";

function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium whitespace-nowrap",
        tone === "neutral" && "text-muted-foreground",
        tone === "good" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        tone === "warn" && "border-amber-200 bg-amber-50 text-amber-800",
        tone === "bad" && "border-red-200 bg-red-50 text-red-700",
        tone === "info" && "border-sky-200 bg-sky-50 text-sky-700",
      )}
    >
      {children}
    </span>
  );
}

const CAPABILITY: Record<Capability, { label: string; tone: "good" | "warn" | "bad" }> = {
  trade: { label: "Trading", tone: "good" },
  read_only: { label: "Read-only", tone: "warn" },
  disabled: { label: "Disabled", tone: "bad" },
};

function AccountBadges({ account }: { account: PortfolioAccount }) {
  const capability = CAPABILITY[account.capability];
  return (
    <span className="flex flex-wrap gap-1">
      <Pill tone={capability.tone}>{capability.label}</Pill>
      {account.isPaper && <Pill tone="info">Paper</Pill>}
      {account.cashOrMargin === "margin" && <Pill>Margin</Pill>}
    </span>
  );
}

function AccountSelector({
  overview,
  selectedId,
  basePath,
}: {
  overview: PortfolioOverview;
  selectedId: string;
  basePath: string;
}) {
  return (
    <nav aria-label="Accounts" className="flex flex-col gap-2">
      {overview.accounts.map((account) => (
        <Link
          key={account.id}
          href={`${basePath}?account=${encodeURIComponent(account.id)}`}
          aria-current={account.id === selectedId ? "page" : undefined}
          className={cn(
            "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/60",
            account.id === selectedId && "border-foreground/30 bg-muted",
          )}
        >
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{account.name}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {account.netValue ? formatMoney(account.netValue.amount, account.netValue.currency) : "—"}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            {account.institution} · {account.maskedNumber}
          </span>
          <AccountBadges account={account} />
        </Link>
      ))}
      {overview.hiddenAccounts > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          {overview.hiddenAccounts} non-investment {overview.hiddenAccounts === 1 ? "account" : "accounts"} (deposit,
          credit, or annuity) not shown.
        </p>
      )}
    </nav>
  );
}

function CashPanel({ result, account }: { result: SnapshotResult; account: PortfolioAccount }) {
  const { balances } = result.snapshot;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Cash and buying power</CardTitle>
        <CardDescription>One row per currency the account holds. Amounts are never converted.</CardDescription>
      </CardHeader>
      <CardContent>
        {balances.length === 0 ? (
          <p className="text-sm text-muted-foreground">The brokerage reported no cash balances.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {balances.map((balance) => (
              <div key={balance.currency} className="rounded-lg border p-3">
                <div className="text-xs font-medium text-muted-foreground">{balance.currency}</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">
                  {formatMoney(balance.cash, balance.currency)}
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  Buying power:{" "}
                  {balance.buyingPower == null
                    ? account.cashOrMargin === "cash"
                      ? "not reported (equals cash for a cash account)"
                      : "not reported by the brokerage"
                    : formatMoney(balance.buyingPower, balance.currency)}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const SEGMENT_COLORS = ["bg-sky-700", "bg-sky-600", "bg-sky-500", "bg-sky-400", "bg-sky-300"];

function segmentColor(kind: "holding" | "other" | "cash", index: number) {
  if (kind === "cash") return "bg-emerald-400";
  if (kind === "other") return "bg-slate-300";
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length];
}

function ConcentrationBar({ concentration }: { concentration: CurrencyConcentration }) {
  const holdings = concentration.segments.filter((segment) => segment.kind === "holding");
  const largest = holdings[0];
  const topShare = holdings.reduce((sum, segment) => sum + segment.weight, 0);
  const cash = concentration.segments.find((segment) => segment.kind === "cash");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{concentration.currency}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatMoney(concentration.total, concentration.currency)} in holdings and cash
        </span>
      </div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${concentration.currency} concentration: ${concentration.segments
          .map((segment) => `${segment.label} ${formatPercent(segment.weight)}`)
          .join(", ")}`}
      >
        {concentration.segments.map((segment, index) => (
          <div
            key={segment.label}
            className={segmentColor(segment.kind, index)}
            style={{ width: `${segment.weight * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {concentration.segments.map((segment, index) => (
          <li key={segment.label} className="flex items-center gap-1.5 tabular-nums">
            <span className={cn("size-2 rounded-full", segmentColor(segment.kind, index))} />
            {segment.label} {formatPercent(segment.weight)}
          </li>
        ))}
      </ul>
      {largest && (
        <p className="text-xs text-muted-foreground">
          Largest position: <span className="font-medium text-foreground">{largest.label}</span> at{" "}
          {formatPercent(largest.weight)}. Top {holdings.length}: {formatPercent(topShare)}
          {cash ? `, cash ${formatPercent(cash.weight)}` : ""}.
        </p>
      )}
    </div>
  );
}

function HoldingsTable({
  result,
  concentration,
}: {
  result: SnapshotResult;
  concentration: CurrencyConcentration[];
}) {
  const weights = new Map(
    concentration.flatMap((entry) =>
      [...entry.weights].map(([symbol, weight]) => [`${entry.currency}:${symbol}`, weight] as const),
    ),
  );
  const { holdings } = result.snapshot;
  if (holdings.length === 0) {
    return <p className="text-sm text-muted-foreground">No positions in this account.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Symbol</th>
            <th className="py-2 pr-3 font-medium">Type</th>
            <th className="py-2 pr-3 text-right font-medium">Units</th>
            <th className="py-2 pr-3 text-right font-medium">Price</th>
            <th className="py-2 pr-3 text-right font-medium">Market value</th>
            <th className="py-2 text-right font-medium">Weight</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding, index) => {
            const currency = holding.currency ?? "";
            const weight = weights.get(`${currency}:${holding.symbol}`);
            return (
              <tr key={`${holding.symbol}-${index}`} className="border-b last:border-0">
                <td className="py-2 pr-3">
                  <div className="font-medium">{holding.symbol}</div>
                  {holding.description && (
                    <div className="text-xs text-muted-foreground">{holding.description}</div>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <span className="flex flex-wrap gap-1">
                    <Pill>{holding.kind.toUpperCase()}</Pill>
                    {holding.cashEquivalent && <Pill tone="info">Counted in cash</Pill>}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatUnits(holding.units)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {holding.price == null ? "—" : formatMoney(holding.price, currency)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatMoney(holding.marketValue, currency)}
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  {weight == null ? "—" : formatPercent(weight)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export type XRayNotice = { tone: "info" | "warn"; text: string };

export function XRayView({
  mode,
  overview,
  selected,
  result,
  basePath,
  notice,
  snapshotError,
}: {
  mode: "live" | "demo";
  overview: PortfolioOverview;
  selected: PortfolioAccount;
  result: SnapshotResult | null;
  basePath: string;
  notice?: XRayNotice;
  snapshotError?: string;
}) {
  const concentration = result ? concentrationByCurrency(result.snapshot) : [];
  return (
    <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
      <AccountSelector overview={overview} selectedId={selected.id} basePath={basePath} />

      <section className="flex min-w-0 flex-col gap-6" aria-labelledby="account-heading">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="account-heading" className="text-xl font-semibold tracking-tight">
              {selected.name}
            </h2>
            <AccountBadges account={selected} />
          </div>
          <p className="text-sm text-muted-foreground">
            {selected.institution} · {selected.maskedNumber} · {selected.capabilityReason}
            {selected.capability === "disabled" && (
              <>
                {" "}
                <a href={SNAPTRADE_DASHBOARD_URL} className="underline underline-offset-4" target="_blank" rel="noreferrer">
                  Open the SnapTrade Dashboard
                </a>
              </>
            )}
          </p>
          {result && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>
                Brokerage data as of {formatTimestamp(result.snapshot.dataAsOf ?? result.snapshot.fetchedAt)}
                {mode === "live" &&
                  ` · ${result.source === "cache" ? "cached" : "fetched"} ${formatTimestamp(result.snapshot.fetchedAt)}`}
              </span>
              {mode === "live" && (
                <form method="post" action={`/api/accounts/${encodeURIComponent(selected.id)}/refresh`}>
                  <Button type="submit" variant="outline" size="xs">
                    Refresh
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>

        {notice && (
          <p
            role={notice.tone === "warn" ? "alert" : "status"}
            className={cn(
              "rounded-md border px-3 py-2 text-xs",
              notice.tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900" : "text-muted-foreground",
            )}
          >
            {notice.text}
          </p>
        )}

        {!result ? (
          <p role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
            {snapshotError ?? "Balances and positions are unavailable right now."}
          </p>
        ) : (
          <>
            {selected.capability === "disabled" && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                This connection is disabled, so SnapTrade returns the last data it synced. Reconnect it in the
                SnapTrade Dashboard for current balances and positions.
              </p>
            )}
            <CashPanel result={result} account={selected} />
            <Card size="sm">
              <CardHeader>
                <CardTitle>Concentration</CardTitle>
                <CardDescription>
                  Top 5 holdings and cash by value, per currency. Cash-equivalent positions are already in cash.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                {concentration.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing to chart yet.</p>
                ) : (
                  concentration.map((entry) => <ConcentrationBar key={entry.currency} concentration={entry} />)
                )}
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Positions</CardTitle>
                <CardDescription>Weight is the share of holdings and cash in the same currency.</CardDescription>
              </CardHeader>
              <CardContent>
                <HoldingsTable result={result} concentration={concentration} />
              </CardContent>
            </Card>
          </>
        )}
      </section>
    </div>
  );
}

export function XRaySkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-[280px_1fr]" aria-hidden>
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-20 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
        <div className="h-48 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}
