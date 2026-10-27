import type { Holding as OverlapHolding } from "@/lib/overlap";
import type { AccountSnapshot, Holding, PortfolioAccount } from "@/lib/portfolio/types";
import type { StudioAccount } from "@/lib/thesis/types";

export type AccountWithSnapshot = { account: PortfolioAccount; snapshot: AccountSnapshot | null };

export type PortfolioHolding = OverlapHolding & {
  accountName: string;
  description: string | null;
  kind: string;
};

export type PortfolioView = {
  holdings: PortfolioHolding[];
  cash: { currency: string; amount: number; accountName: string }[];
  /** Positive holdings plus cash, per currency. Nothing is converted. */
  totals: Map<string, number>;
  /** Accounts whose balances and positions couldn't be loaded. */
  unavailable: string[];
};

// Holdings without a currency fall back to the account's only cash currency.
function currencyOf(holding: Holding, snapshot: AccountSnapshot): string | null {
  if (holding.currency) return holding.currency.toUpperCase();
  return snapshot.balances.length === 1 ? snapshot.balances[0].currency.toUpperCase() : null;
}

export const accountLabel = (account: PortfolioAccount) => `${account.name} (${account.institution})`;

export function toStudioAccount({ account, snapshot }: AccountWithSnapshot): StudioAccount {
  return {
    id: account.id,
    name: account.name,
    institution: account.institution,
    maskedNumber: account.maskedNumber,
    isPaper: account.isPaper,
    capability: account.capability,
    cash: snapshot
      ? snapshot.balances.flatMap((balance) =>
          balance.cash == null ? [] : [{ currency: balance.currency.toUpperCase(), amount: balance.cash }],
        )
      : null,
  };
}

/** The account the Studio opens on: the requested one, else the first that can trade. */
export function initialStudioAccount(accounts: readonly StudioAccount[], requested: unknown): StudioAccount {
  return (
    accounts.find((account) => account.id === requested) ??
    accounts.find((account) => account.capability === "trade") ??
    accounts[0]
  );
}

/**
 * Every position across the user's accounts, for the LLM context and the
 * overlap check. Cash-equivalent positions are already inside cash, and
 * positions without a value or currency can't be compared, so both are left
 * out. Shorts stay in: the overlap rule nets them.
 */
export function collectPortfolio(entries: readonly AccountWithSnapshot[]): PortfolioView {
  const holdings: PortfolioHolding[] = [];
  const cash: PortfolioView["cash"] = [];
  const totals = new Map<string, number>();
  const unavailable: string[] = [];
  const add = (currency: string, amount: number) => totals.set(currency, (totals.get(currency) ?? 0) + amount);

  for (const { account, snapshot } of entries) {
    if (!snapshot) {
      unavailable.push(accountLabel(account));
      continue;
    }
    for (const balance of snapshot.balances) {
      if (balance.cash == null || !Number.isFinite(balance.cash)) continue;
      const currency = balance.currency.toUpperCase();
      cash.push({ currency, amount: balance.cash, accountName: accountLabel(account) });
      if (balance.cash > 0) add(currency, balance.cash);
    }
    for (const holding of snapshot.holdings) {
      const currency = currencyOf(holding, snapshot);
      if (holding.cashEquivalent || holding.marketValue == null || !Number.isFinite(holding.marketValue) || !currency) {
        continue;
      }
      holdings.push({
        accountId: account.id,
        accountName: accountLabel(account),
        symbol: holding.symbol,
        shareClassFigi: holding.figiShareClass,
        marketValue: holding.marketValue,
        currency,
        description: holding.description,
        kind: holding.kind,
      });
      if (holding.marketValue > 0) add(currency, holding.marketValue);
    }
  }
  return { holdings, cash, totals, unavailable };
}
