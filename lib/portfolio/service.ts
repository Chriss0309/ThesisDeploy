import { getGrantSummary } from "@/lib/auth/vault";
import { getDb } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";
import { normalizeAccounts, normalizeSnapshot } from "@/lib/portfolio/normalize";
import type {
  AccountSnapshot,
  CashBalance,
  Holding,
  PortfolioAccount,
  PortfolioOverview,
} from "@/lib/portfolio/types";
import { SnapTradeError, callSnapTrade, type SnapTradeContext } from "@/lib/snaptrade/client";
import { recordEvent } from "@/lib/telemetry/events";

/** Balances and positions are re-fetched at most every 10 minutes unless the user refreshes. */
export const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

const inFlight = new Map<string, Promise<unknown>>();

// Identical concurrent loads share one set of SnapTrade calls instead of each
// spending the per-account budget. Next.js renders /portfolio twice per
// request with Partial Prefetching; double submits and extra tabs do the same.
function coalesce<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = load().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// Connections and the account list are not account-scoped, so they don't
// count against the per-account limit; the account list is Daily-cached by SnapTrade.
export function loadOverview(ctx: SnapTradeContext): Promise<PortfolioOverview> {
  return coalesce(`overview:${ctx.userId}`, () => fetchOverview(ctx));
}

async function fetchOverview(ctx: SnapTradeContext): Promise<PortfolioOverview> {
  const [connections, accounts, grant] = await Promise.all([
    callSnapTrade(ctx, "listBrokerageAuthorizations", (api) =>
      api.connections.listBrokerageAuthorizations(),
    ),
    callSnapTrade(ctx, "listAllUserAccounts", (api) => api.accounts.listAllUserAccounts()),
    getGrantSummary(ctx.userId),
  ]);
  const overview = normalizeAccounts(connections, accounts, grant?.scopes ?? []);
  await recordEvent(
    "accounts_loaded",
    { accounts: overview.accounts.length, hiddenAccounts: overview.hiddenAccounts },
    ctx.userId,
  );
  return overview;
}

export type SnapshotResult = {
  snapshot: AccountSnapshot;
  source: "live" | "cache";
  /** Set when a live fetch was skipped or failed and cached data is shown instead. */
  warning?: { reason: "rate_limited" | "unavailable"; retryAfterSeconds: number | null };
};

async function readCached(userId: string, accountId: string): Promise<AccountSnapshot | null> {
  const row = await getDb().accountSnapshot.findUnique({
    where: { userId_accountId: { userId, accountId } },
  });
  if (!row) return null;
  return {
    accountId,
    balances: row.balances as unknown as CashBalance[],
    holdings: row.positions as unknown as Holding[],
    dataAsOf: row.dataAsOf?.toISOString() ?? null,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

async function saveSnapshot(userId: string, snapshot: AccountSnapshot): Promise<void> {
  const data = {
    balances: snapshot.balances as unknown as Prisma.InputJsonArray,
    positions: snapshot.holdings as unknown as Prisma.InputJsonArray,
    dataAsOf: snapshot.dataAsOf ? new Date(snapshot.dataAsOf) : null,
    fetchedAt: new Date(snapshot.fetchedAt),
  };
  await getDb().accountSnapshot.upsert({
    where: { userId_accountId: { userId, accountId: snapshot.accountId } },
    create: { userId, accountId: snapshot.accountId, ...data },
    update: data,
  });
}

async function fetchSnapshot(ctx: SnapTradeContext, account: PortfolioAccount) {
  const options = { accountId: account.id, brokerageSlug: account.brokerageSlug };
  const [balances, positions] = await Promise.all([
    callSnapTrade(
      ctx,
      "getUserAccountBalance",
      (api) => api.accounts.getUserAccountBalance({ accountId: account.id }),
      options,
    ),
    callSnapTrade(
      ctx,
      "getAllAccountPositions",
      (api) => api.accounts.getAllAccountPositions({ accountId: account.id }),
      options,
    ),
  ]);
  return normalizeSnapshot(account.id, balances, positions, new Date());
}

/**
 * Two account-scoped calls per live fetch (balances + positions). When a fetch
 * is rate limited or SnapTrade is unreachable, the last cached snapshot is
 * returned with a warning rather than an error page.
 */
export function getSnapshot(
  ctx: SnapTradeContext,
  account: PortfolioAccount,
  options: { refresh?: boolean } = {},
): Promise<SnapshotResult> {
  const mode = options.refresh ? "refresh" : "read";
  return coalesce(`snapshot:${ctx.userId}:${account.id}:${mode}`, () =>
    loadSnapshot(ctx, account, options),
  );
}

async function loadSnapshot(
  ctx: SnapTradeContext,
  account: PortfolioAccount,
  options: { refresh?: boolean },
): Promise<SnapshotResult> {
  const cached = await readCached(ctx.userId, account.id);
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < SNAPSHOT_TTL_MS;
  if (cached && fresh && !options.refresh) return { snapshot: cached, source: "cache" };

  try {
    const snapshot = await fetchSnapshot(ctx, account);
    await saveSnapshot(ctx.userId, snapshot);
    return { snapshot, source: "live" };
  } catch (error) {
    if (!cached || !(error instanceof SnapTradeError)) throw error;
    const limited = error.code === "rate_limited" || error.code === "budget_exhausted";
    return {
      snapshot: cached,
      source: "cache",
      warning: {
        reason: limited ? "rate_limited" : "unavailable",
        retryAfterSeconds: error.retryAfterSeconds,
      },
    };
  }
}

export async function deleteSnapshots(userId: string): Promise<void> {
  await getDb().accountSnapshot.deleteMany({ where: { userId } });
}
