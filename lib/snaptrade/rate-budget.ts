import { getDb } from "@/lib/db/client";

/** SnapTrade's default per-account limit for account-data endpoints (rolling 60s). */
export const ACCOUNT_LIMIT_PER_MINUTE = 10;
/** Our ceiling, below SnapTrade's, so concurrent requests can't overshoot it. */
export const ACCOUNT_BUDGET_PER_MINUTE = 8;

export type BudgetWindow = {
  /** Account-scoped calls recorded in the trailing 60 seconds. */
  used: number;
  /** Seconds until the oldest call in the window leaves it. */
  secondsUntilSlot: number | null;
  /** X-RateLimit-Account-Remaining from the most recent response in the window. */
  lastRemaining: number | null;
};

export type BudgetDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function decideBudget(window: BudgetWindow): BudgetDecision {
  if (window.used < ACCOUNT_BUDGET_PER_MINUTE && window.lastRemaining !== 0) {
    return { allowed: true };
  }
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(window.secondsUntilSlot ?? 60)) };
}

/**
 * The budget is read from `api_calls`, so it is shared by every serverless
 * instance. Only this app uses its OAuth client ID, and SnapTrade buckets the
 * limit by client ID and account, so the table sees every call that counts.
 */
export async function readBudgetWindow(accountHash: string): Promise<BudgetWindow> {
  const [row] = await getDb().$queryRaw<
    { used: number; seconds_until_slot: number | null; last_remaining: number | null }[]
  >`
    select count(*)::int as used,
           extract(epoch from min(created_at) + interval '60 seconds' - now())::float8
             as seconds_until_slot,
           (array_agg(account_remaining order by created_at desc)
              filter (where account_remaining is not null))[1] as last_remaining
    from api_calls
    where account_hash = ${accountHash}
      and created_at > now() - interval '60 seconds'
  `;
  return {
    used: row?.used ?? 0,
    secondsUntilSlot: row?.seconds_until_slot ?? null,
    lastRemaining: row?.last_remaining ?? null,
  };
}
