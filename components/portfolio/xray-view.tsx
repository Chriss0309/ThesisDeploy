import Link from "next/link";
import type { ReactNode } from "react";

import { Loader } from "@/components/loader/loader";
import { Mark, Reveal } from "@/components/loader/mark";
import { LinkPendingStatus, PendingForm } from "@/components/loader/pending";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, formatPercent, formatTimestamp, formatUnits } from "@/components/portfolio/format";
import { concentrationByCurrency, type CurrencyConcentration } from "@/lib/portfolio/concentration";
import type { SnapshotResult } from "@/lib/portfolio/service";
import type { Capability, PortfolioAccount, PortfolioOverview } from "@/lib/portfolio/types";
import { cn } from "@/lib/utils";

export const SNAPTRADE_DASHBOARD_URL = "https://dashboard.snaptrade.com";

const CAPABILITY: Record<Capability, { label: string; tone: "positive" | "warning" | "negative" }> = {
  trade: { label: "Trading", tone: "positive" },
  read_only: { label: "Read-only", tone: "warning" },
  disabled: { label: "Disabled", tone: "negative" },
};

function AccountBadges({ account }: { account: PortfolioAccount }) {
  const capability = CAPABILITY[account.capability];
  return (
    <span className="flex flex-wrap gap-1">
      <Badge tone={capability.tone} dot>
        {capability.label}
      </Badge>
      {account.isPaper && <Badge tone="info">Paper</Badge>}
      {account.cashOrMargin === "margin" && <Badge>Margin</Badge>}
    </span>
  );
}

const NOTICE_MARK = { info: "success", warn: "rate-limit", error: "error" } as const;

function Notice({ tone, children }: { tone: "info" | "warn" | "error"; children: ReactNode }) {
  return (
    <p
      role={tone === "info" ? "status" : "alert"}
      className={cn(
        "flex items-center gap-2.5 rounded-md border px-3 py-2 text-xs",
        tone === "info" && "border-border bg-surface-sunken text-muted-foreground",
        tone === "warn" && "border-warning-border bg-warning-subtle text-warning-subtle-foreground",
        tone === "error" && "border-negative-border bg-negative-subtle text-negative-subtle-foreground",
      )}
    >
      <Mark kind={NOTICE_MARK[tone]} size="inline" />
      <span>{children}</span>
    </p>
  );
}

function AccountSelector({
  overview,
  selectedId,
  basePath,
  mode,
}: {
  overview: PortfolioOverview;
  selectedId: string;
  basePath: string;
  mode: "live" | "demo";
}) {
  return (
    <nav aria-label="Accounts" className="flex min-w-0 flex-col gap-2">
      <h2 className="eyebrow text-muted-foreground">Accounts · {overview.accounts.length}</h2>
      <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {overview.accounts.map((account) => (
          <Link
            key={account.id}
            href={`${basePath}?account=${encodeURIComponent(account.id)}`}
            aria-current={account.id === selectedId ? "page" : undefined}
            className="flex w-64 shrink-0 snap-start flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-3 text-sm transition-colors outline-none hover:border-border-strong hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/30 has-data-link-pending:opacity-70 aria-[current=page]:border-foreground aria-[current=page]:shadow-sm lg:w-auto"
          >
            <LinkPendingStatus
              variant="scan"
              label={mode === "live" ? `Loading ${account.name} from SnapTrade…` : `Loading ${account.name}…`}
            />
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{account.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {account.netValue ? formatMoney(account.netValue.amount, account.netValue.currency) : "—"}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {account.institution} · <span className="font-mono">{account.maskedNumber}</span>
            </span>
            <AccountBadges account={account} />
          </Link>
        ))}
      </div>
      {overview.hiddenAccounts > 0 && (
        <p className="text-xs text-muted-foreground">
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
              <div key={balance.currency} className="flex flex-col gap-1 rounded-md bg-surface-sunken p-4">
                <div className="eyebrow text-muted-foreground">► Cash · {balance.currency}</div>
                <div className="font-display text-2xl font-semibold tabular-nums sm:text-3xl">
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

const SEGMENT_COLORS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

function segmentColor(kind: "holding" | "other" | "cash", index: number) {
  if (kind === "cash") return "hatch";
  if (kind === "other") return "bg-chart-other";
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length];
}

function ConcentrationBar({ concentration }: { concentration: CurrencyConcentration }) {
  const holdings = concentration.segments.filter((segment) => segment.kind === "holding");
  const largest = holdings[0];
  const topShare = holdings.reduce((sum, segment) => sum + segment.weight, 0);
  const cash = concentration.segments.find((segment) => segment.kind === "cash");
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="eyebrow text-foreground">{concentration.currency}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatMoney(concentration.total, concentration.currency)} in holdings and cash
        </span>
      </div>
      <div
        className="flex h-4 w-full gap-px overflow-hidden rounded-xs bg-chart-track"
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
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {concentration.segments.map((segment, index) => (
          <li key={segment.label} className="flex items-center gap-1.5 tabular-nums">
            <span className={cn("size-2.5 rounded-xs", segmentColor(segment.kind, index))} />
            <span className="font-mono text-foreground">{segment.label}</span> {formatPercent(segment.weight)}
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
    return (
      <div className="flex items-center gap-4">
        <Mark kind="empty" />
        <p className="text-sm text-muted-foreground">No positions in this account.</p>
      </div>
    );
  }
  return (
    <div className="-mx-(--card-spacing) overflow-x-auto px-(--card-spacing)">
      <table className="w-full text-sm sm:min-w-(--table-min)">
        <thead>
          <tr className="eyebrow border-b border-border-strong text-left text-muted-foreground">
            <th className="py-2.5 pr-3 font-medium">Symbol</th>
            <th className="hidden py-2.5 pr-3 font-medium sm:table-cell">Type</th>
            <th className="py-2.5 pr-3 text-right font-medium">Units</th>
            <th className="hidden py-2.5 pr-3 text-right font-medium sm:table-cell">Price</th>
            <th className="py-2.5 pr-3 text-right font-medium">Market value</th>
            <th className="py-2.5 text-right font-medium">Weight</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding, index) => {
            const currency = holding.currency ?? "";
            const weight = weights.get(`${currency}:${holding.symbol}`);
            const kindBadges = (
              <>
                <Badge>{holding.kind.toUpperCase()}</Badge>
                {holding.cashEquivalent && <Badge tone="info">Counted in cash</Badge>}
              </>
            );
            return (
              <tr
                key={`${holding.symbol}-${index}`}
                className="border-b transition-colors last:border-0 hover:bg-surface-sunken"
              >
                <td className="py-3 pr-3">
                  <div className="font-mono text-sm font-medium">{holding.symbol}</div>
                  {holding.description && (
                    <div className="text-xs text-muted-foreground">{holding.description}</div>
                  )}
                  <span className="mt-1.5 flex flex-wrap gap-1 sm:hidden">{kindBadges}</span>
                </td>
                <td className="hidden py-3 pr-3 sm:table-cell">
                  <span className="flex flex-wrap gap-1">{kindBadges}</span>
                </td>
                <td className="py-3 pr-3 text-right tabular-nums">{formatUnits(holding.units)}</td>
                <td className="hidden py-3 pr-3 text-right tabular-nums sm:table-cell">
                  {holding.price == null ? "—" : formatMoney(holding.price, currency)}
                </td>
                <td className="py-3 pr-3 text-right font-medium tabular-nums">
                  {formatMoney(holding.marketValue, currency)}
                </td>
                <td className="py-3 text-right text-muted-foreground tabular-nums">
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
    <div className="grid gap-6 lg:grid-cols-(--grid-xray) lg:gap-10">
      <Reveal />
      <AccountSelector overview={overview} selectedId={selected.id} basePath={basePath} mode={mode} />

      <section className="flex min-w-0 flex-col gap-5" aria-labelledby="account-heading">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 id="account-heading" className="font-display text-2xl font-semibold">
              {selected.name}
            </h2>
            <AccountBadges account={selected} />
          </div>
          <p className="text-sm text-muted-foreground">
            {selected.institution} · <span className="font-mono">{selected.maskedNumber}</span> ·{" "}
            {selected.capabilityReason}
            {selected.capability === "disabled" && (
              <>
                {" "}
                <a
                  href={SNAPTRADE_DASHBOARD_URL}
                  className="font-medium text-brand underline underline-offset-4 hover:text-brand-hover"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open the SnapTrade Dashboard
                </a>
              </>
            )}
          </p>
          {result && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="tabular-nums">
                Brokerage data as of {formatTimestamp(result.snapshot.dataAsOf ?? result.snapshot.fetchedAt)}
                {mode === "live" &&
                  ` · ${result.source === "cache" ? "cached" : "fetched"} ${formatTimestamp(result.snapshot.fetchedAt)}`}
              </span>
              {mode === "live" && (
                <PendingForm
                  method="post"
                  action={`/api/accounts/${encodeURIComponent(selected.id)}/refresh`}
                  variant="scan"
                  pendingLabel={`Refreshing ${selected.name} from SnapTrade…`}
                >
                  <Button type="submit" variant="outline" size="xs">
                    Refresh
                  </Button>
                </PendingForm>
              )}
            </div>
          )}
        </div>

        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

        {!result ? (
          <Notice tone="error">{snapshotError ?? "Balances and positions are unavailable right now."}</Notice>
        ) : (
          <>
            {selected.capability === "disabled" && (
              <p className="rounded-md border border-negative-border bg-negative-subtle px-3 py-2.5 text-xs text-negative-subtle-foreground">
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

export function XRaySkeleton({
  label = "Reading your accounts from SnapTrade…",
  detail = "Balances and positions for each account, cached for 10 minutes after this.",
}: {
  label?: string;
  detail?: string;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-(--grid-xray) lg:gap-10">
      <div className="flex flex-col gap-2" aria-hidden>
        <div className="h-4" />
        <div className="flex gap-2 overflow-hidden lg:flex-col">
          {[0, 1, 2].map((key) => (
            <div key={key} className="h-24 w-64 shrink-0 rounded-md bg-muted lg:w-auto" />
          ))}
        </div>
      </div>
      <Loader variant="scan" label={label} detail={detail} />
    </div>
  );
}
