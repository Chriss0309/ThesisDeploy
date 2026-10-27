import { ReauthRequiredError } from "@/lib/auth/vault";
import { liveTradingEnabled, serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import type { LiveGateInput } from "@/lib/execution/live-gate";
import { getSnapshot } from "@/lib/portfolio/service";
import type { PortfolioAccount } from "@/lib/portfolio/types";
import { callSnapTrade, type SnapTradeContext } from "@/lib/snaptrade/client";

export function currentKillSwitch(): LiveGateInput["killSwitch"] {
  const env = serverEnv();
  return { on: liveTradingEnabled(env), preview: env.VERCEL_ENV === "preview" };
}

export type AccountState = {
  /** Buying power (cash for non-margin accounts) in the basket currency. */
  buyingPower: number | null;
  /** Shares held per symbol, as the broker reports them. */
  held: Map<string, number>;
};

/**
 * Balances and positions read fresh for Live gating: two account-limited
 * calls, which also refresh Portfolio X-Ray's cache. Returns null when
 * SnapTrade couldn't answer, so Live is blocked rather than gated on stale data.
 */
export async function freshAccountState(
  ctx: SnapTradeContext,
  account: PortfolioAccount,
  currency: string,
): Promise<AccountState | null> {
  try {
    const result = await getSnapshot(ctx, account, { refresh: true });
    if (result.source !== "live") return null;
    const balance = result.snapshot.balances.find((entry) => entry.currency.toUpperCase() === currency.toUpperCase());
    const held = new Map<string, number>();
    for (const holding of result.snapshot.holdings) {
      const symbol = holding.symbol.toUpperCase();
      held.set(symbol, (held.get(symbol) ?? 0) + holding.units);
    }
    return { buyingPower: balance ? (balance.buyingPower ?? balance.cash) : null, held };
  } catch (error) {
    if (error instanceof ReauthRequiredError) throw error;
    console.error("[live] account state unavailable", describeError(error));
    return null;
  }
}

/** A deploy needs only buying power: one account-limited balance call. Null when SnapTrade couldn't answer. */
export async function freshBuyingPower(
  ctx: SnapTradeContext,
  account: PortfolioAccount,
  currency: string,
): Promise<number | null> {
  try {
    const balances = await callSnapTrade(
      ctx,
      "getUserAccountBalance",
      (api) => api.accounts.getUserAccountBalance({ accountId: account.id }),
      { accountId: account.id, brokerageSlug: account.brokerageSlug },
    );
    const entry = balances.find((balance) => balance.currency?.code?.toUpperCase() === currency.toUpperCase());
    const value = Number(entry?.buying_power ?? entry?.cash);
    return entry && Number.isFinite(value) ? value : null;
  } catch (error) {
    if (error instanceof ReauthRequiredError) throw error;
    console.error("[live] buying power unavailable", describeError(error));
    return null;
  }
}
