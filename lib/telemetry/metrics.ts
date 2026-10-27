import { getDb } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import type {
  BrokerageOrders,
  FunnelCohort,
  OperationLatency,
  ResolutionSource,
  TelemetrySnapshot,
} from "@/lib/telemetry/types";

export const WINDOW_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

/** Whose activity to aggregate: null for everyone, otherwise a user and/or a demo cookie. */
export type TelemetryScope = { userId: string | null; guestKey: string | null } | null;

/** Order attempts that reached the broker (or the paper simulator) and were taken. */
const SUCCEEDED = ["executed", "accepted", "partial"];

// Every query is bounded by the window and served by an index: events by
// (name, created_at), (user_id), or (guest_key, created_at); api_calls by
// (created_at) or (user_id).
function eventFilter(scope: TelemetryScope): Prisma.Sql {
  if (!scope) return Prisma.empty;
  const owners: Prisma.Sql[] = [];
  if (scope.userId) owners.push(Prisma.sql`user_id = ${scope.userId}::uuid`);
  if (scope.guestKey) owners.push(Prisma.sql`guest_key = ${scope.guestKey}`);
  return owners.length > 0 ? Prisma.sql`and (${Prisma.join(owners, " or ")})` : Prisma.sql`and false`;
}

type FunnelRow = {
  guest: boolean;
  connected: number;
  generated: number;
  deployed: number;
  baskets_generated: number;
  baskets_deployed: number;
  viewed_drift: number;
  rebalanced: number;
  closed: number;
};

/**
 * Distinct people per step. A signed-in person enters by connecting within the
 * window; a guest enters with their first basket. Later steps count only
 * people who reached the earlier ones, so the funnel never widens. My Theses
 * activity is counted among the people who deployed.
 */
async function funnel(since: Date, scope: TelemetryScope): Promise<TelemetrySnapshot["funnel"]> {
  const rows = await getDb().$queryRaw<FunnelRow[]>`
    with actors as (
      select user_id is null as guest,
             bool_or(name = 'oauth_connected') as connected,
             count(*) filter (where name = 'thesis_generated') as generated,
             count(*) filter (where name = 'basket_deployed') as deployed,
             bool_or(name = 'drift_viewed') as viewed_drift,
             bool_or(name = 'rebalance_confirmed') as rebalanced,
             bool_or(name = 'basket_closed') as closed
      from events
      where name in ('oauth_connected', 'thesis_generated', 'basket_deployed', 'drift_viewed', 'rebalance_confirmed', 'basket_closed')
        and created_at >= ${since}
        and (user_id is not null or guest_key is not null)
        ${eventFilter(scope)}
      group by user_id, guest_key
    ), entered as (
      select *, generated > 0 and deployed > 0 as reached_deploy from actors where connected or guest
    )
    select guest,
           count(*) filter (where connected)::int as connected,
           count(*) filter (where generated > 0)::int as generated,
           count(*) filter (where reached_deploy)::int as deployed,
           coalesce(sum(generated), 0)::int as baskets_generated,
           coalesce(sum(deployed), 0)::int as baskets_deployed,
           count(*) filter (where reached_deploy and viewed_drift)::int as viewed_drift,
           count(*) filter (where reached_deploy and rebalanced)::int as rebalanced,
           count(*) filter (where reached_deploy and closed)::int as closed
    from entered
    group by guest`;
  const cohort = (guest: boolean): FunnelCohort => {
    const row = rows.find((candidate) => candidate.guest === guest);
    return {
      connected: guest ? null : (row?.connected ?? 0),
      generated: row?.generated ?? 0,
      deployed: row?.deployed ?? 0,
      baskets: { generated: row?.baskets_generated ?? 0, deployed: row?.baskets_deployed ?? 0 },
      afterDeploy: {
        viewedDrift: row?.viewed_drift ?? 0,
        rebalanced: row?.rebalanced ?? 0,
        closed: row?.closed ?? 0,
      },
    };
  };
  return { signedIn: cohort(false), guest: cohort(true) };
}

type ResolutionRow = { guest: boolean; reason: string | null; proposed: number; resolved: number; count: number };

/** Tickers Claude proposed vs. tickers grounding resolved, per served basket. */
async function resolution(since: Date, scope: TelemetryScope): Promise<ResolutionSource[]> {
  const rows = await getDb().$queryRaw<ResolutionRow[]>`
    with served as (
      select coalesce((props->>'guest')::boolean, false) as guest, props
      from events
      where name = 'symbols_resolved' and created_at >= ${since} ${eventFilter(scope)}
    )
    select guest, null as reason,
           coalesce(sum((props->>'proposed')::int), 0)::int as proposed,
           coalesce(sum((props->>'resolved')::int), 0)::int as resolved,
           0 as count
    from served group by guest
    union all
    select guest, d.key, 0, 0, sum(d.value::int)::int
    from served
    cross join lateral jsonb_each_text(
      case when jsonb_typeof(props->'dropped') = 'object' then props->'dropped' else '{}'::jsonb end
    ) d
    group by guest, d.key`;
  return [false, true].flatMap((guest): ResolutionSource[] => {
    const total = rows.find((row) => row.guest === guest && row.reason == null);
    if (!total || total.proposed === 0) return [];
    const dropped = rows
      .filter((row) => row.guest === guest && row.reason != null && row.count > 0)
      .map((row) => ({ reason: row.reason!, count: row.count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    return [{ source: guest ? "demo" : "snaptrade", proposed: total.proposed, resolved: total.resolved, dropped }];
  });
}

type EditRow = { edited: number; removed: number; resized: number };

/**
 * Suggested tickers the user removed or resized before pre-flight, over every
 * ticker shown in the composer. A ticker counts once per basket; removed then
 * restored is not an edit.
 */
async function edits(since: Date, scope: TelemetryScope): Promise<TelemetrySnapshot["edits"]> {
  const filter = eventFilter(scope);
  const [[edited], [shown]] = await Promise.all([
    getDb().$queryRaw<EditRow[]>`
      with touched as (
        select bool_or(props->>'action' in ('reweight', 'step')) as resized,
               (array_agg(props->>'action' order by id desc)
                  filter (where props->>'action' in ('remove', 'restore')))[1] is not distinct from 'remove' as removed
        from events
        where name = 'basket_edited' and created_at >= ${since} ${filter}
        group by coalesce(props->>'thesisId', props->>'ref'), props->>'symbol'
      )
      select count(*) filter (where removed or resized)::int as edited,
             count(*) filter (where removed)::int as removed,
             count(*) filter (where resized and not removed)::int as resized
      from touched`,
    getDb().$queryRaw<{ suggested: number }[]>`
      select coalesce(sum((props->>'resolved')::int), 0)::int as suggested
      from events
      where name = 'symbols_resolved' and created_at >= ${since} ${filter}`,
  ]);
  return { suggested: shown?.suggested ?? 0, ...(edited ?? { edited: 0, removed: 0, resized: 0 }) };
}

type OrderRow = Omit<BrokerageOrders, "byKind"> & { deploy: number; rebalance: number; close: number };

/**
 * Leg attempts by brokerage and mode, across deploy, rebalance, and close
 * runs; `pending` results (a 429 put the leg back) aren't orders yet. Each
 * attempt is its own leg row, and a Live one can report again when its broker
 * status is checked, so an attempt counts once, with its latest result; legs
 * recorded without a `legId` predate Live and count per event. Guest legs run
 * on fictional demo accounts, so they count as `demo` whatever brokerage the
 * fixture names. Legs recorded without a kind predate My Theses, when every
 * run was a deploy.
 */
async function orders(since: Date, scope: TelemetryScope): Promise<BrokerageOrders[]> {
  const rows = await getDb().$queryRaw<OrderRow[]>`
    with results as (
      select distinct on (coalesce(props->>'legId', id::text)) props
      from events
      where name = 'leg_result' and created_at >= ${since}
        and props->>'status' is distinct from 'pending'
        ${eventFilter(scope)}
      order by coalesce(props->>'legId', id::text), id desc
    )
    select case when (props->>'guest')::boolean then 'demo' else coalesce(props->>'brokerage', 'unknown') end as brokerage,
           case when props->>'mode' = 'live' then 'live' else 'paper' end as mode,
           count(*)::int as orders,
           count(*) filter (where props->>'status' = any(${SUCCEEDED}))::int as succeeded,
           count(*) filter (where coalesce(props->>'kind', 'deploy') = 'deploy')::int as deploy,
           count(*) filter (where props->>'kind' = 'rebalance')::int as rebalance,
           count(*) filter (where props->>'kind' = 'close')::int as close
    from results
    group by 1, 2
    order by orders desc, brokerage`;
  return rows.map(({ deploy, rebalance, close, ...row }) => ({ ...row, byKind: { deploy, rebalance, close } }));
}

type LatencyRow = OperationLatency & { last_429_at: Date | null };

/** Every recorded SnapTrade call, failures included: that's the wait users saw. */
async function latency(since: Date, scope: TelemetryScope) {
  if (scope && !scope.userId) return { latency: [], rateLimits: { count: 0, calls: 0, lastAt: null } };
  const filter = scope ? Prisma.sql`and user_id = ${scope.userId}::uuid` : Prisma.empty;
  const rows = await getDb().$queryRaw<LatencyRow[]>`
    select operation,
           count(*)::int as calls,
           count(*) filter (where http_status is null or http_status >= 400)::int as errors,
           count(*) filter (where http_status = 429)::int as "rateLimited",
           round(percentile_cont(0.5) within group (order by latency_ms))::int as "p50Ms",
           round(percentile_cont(0.95) within group (order by latency_ms))::int as "p95Ms",
           max(created_at) filter (where http_status = 429) as last_429_at
    from api_calls
    where created_at >= ${since} ${filter}
    group by operation
    order by calls desc, operation`;
  const last = rows.reduce<Date | null>(
    (latest, row) => (row.last_429_at && (!latest || row.last_429_at > latest) ? row.last_429_at : latest),
    null,
  );
  return {
    latency: rows.map((row): OperationLatency => ({
      operation: row.operation,
      calls: row.calls,
      errors: row.errors,
      rateLimited: row.rateLimited,
      p50Ms: row.p50Ms,
      p95Ms: row.p95Ms,
    })),
    rateLimits: {
      count: rows.reduce((sum, row) => sum + row.rateLimited, 0),
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      lastAt: last?.toISOString() ?? null,
    },
  };
}

export async function telemetrySnapshot(scope: TelemetryScope, now = new Date()): Promise<TelemetrySnapshot> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const [funnelResult, editResult, resolutionResult, orderResult, calls] = await Promise.all([
    funnel(since, scope),
    edits(since, scope),
    resolution(since, scope),
    orders(since, scope),
    latency(since, scope),
  ]);
  return {
    funnel: funnelResult,
    edits: editResult,
    resolution: resolutionResult,
    orders: orderResult,
    ...calls,
  };
}

const GLOBAL_TTL_MS = 60_000;
let globalCache: { at: number; value: Promise<TelemetrySnapshot> } | null = null;

/** Everyone's aggregates, shared per server instance for a minute (and across concurrent requests). */
export function globalTelemetry(now = Date.now()): Promise<TelemetrySnapshot> {
  if (!globalCache || now - globalCache.at > GLOBAL_TTL_MS) {
    const value = telemetrySnapshot(null, new Date(now)).catch((error: unknown) => {
      globalCache = null;
      throw error;
    });
    globalCache = { at: now, value };
  }
  return globalCache.value;
}

export function resetTelemetryCache(): void {
  globalCache = null;
}
