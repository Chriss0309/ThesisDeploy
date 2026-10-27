import type {
  AccountPosition,
  AllAccountPositionsResponse,
  AllUserAccountsResponse,
  Balance,
  BrokerageAuthorization,
} from "snaptrade-typescript-sdk";

import type {
  AccountSnapshot,
  Capability,
  CashBalance,
  Holding,
  PortfolioAccount,
  PortfolioOverview,
} from "@/lib/portfolio/types";

function capabilityOf(
  connection: BrokerageAuthorization | undefined,
  grantScopes: string[],
): { capability: Capability; capabilityReason: string } {
  if (!connection) {
    return { capability: "read_only", capabilityReason: "Connection details unavailable" };
  }
  if (connection.disabled) {
    return {
      capability: "disabled",
      capabilityReason: "Connection needs to be reconnected in the SnapTrade Dashboard",
    };
  }
  if (connection.type !== "trade") {
    return { capability: "read_only", capabilityReason: "Read-only connection" };
  }
  if (connection.brokerage?.allows_trading === false) {
    return {
      capability: "read_only",
      capabilityReason: "This brokerage doesn't support trading through SnapTrade",
    };
  }
  if (!grantScopes.includes("trade")) {
    return {
      capability: "read_only",
      capabilityReason: "Trading wasn't authorized for ThesisDeploy",
    };
  }
  return { capability: "trade", capabilityReason: "Trading enabled" };
}

export function normalizeAccounts(
  connections: BrokerageAuthorization[],
  accounts: AllUserAccountsResponse,
  grantScopes: string[],
): PortfolioOverview {
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const investment = accounts.results.filter((account) => account.kind === "investment");

  return {
    hiddenAccounts: accounts.results.length - investment.length,
    accounts: investment.map((account) => {
      const connection = connectionsById.get(account.connection_id);
      const netValue = account.net_value;
      return {
        id: account.id,
        name: account.display_name || account.raw_type || "Account",
        institution:
          connection?.brokerage?.display_name ?? connection?.brokerage?.name ?? "Unknown brokerage",
        brokerageSlug: connection?.brokerage?.slug ?? null,
        maskedNumber: account.masked_account_number,
        connectionId: account.connection_id,
        isPaper: account.is_paper,
        cashOrMargin: account.cash_or_margin ?? "unknown",
        netValue:
          netValue?.amount != null && netValue.currency
            ? { amount: netValue.amount, currency: netValue.currency }
            : null,
        ...capabilityOf(connection, grantScopes),
      } satisfies PortfolioAccount;
    }),
  };
}

function parseNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHolding(position: AccountPosition): Holding {
  const instrument = position.instrument as AccountPosition["instrument"] & {
    symbol?: string;
    description?: string | null;
    currency?: string | null;
    figi_instrument?: { figi_share_class?: string | null } | null;
  };
  const units = parseNumber(position.units) ?? 0;
  const price = parseNumber(position.price);
  return {
    symbol: instrument.symbol ?? "Unknown",
    description: instrument.description ?? null,
    kind: instrument.kind,
    currency: position.currency ?? instrument.currency ?? null,
    units,
    price,
    marketValue: price == null ? null : units * price,
    cashEquivalent: position.cash_equivalent === true,
    figiShareClass: instrument.figi_instrument?.figi_share_class ?? null,
  };
}

export function normalizeSnapshot(
  accountId: string,
  balances: Balance[],
  positions: AllAccountPositionsResponse,
  fetchedAt: Date,
): AccountSnapshot {
  const cash: CashBalance[] = balances
    .filter((balance) => balance.currency?.code)
    .map((balance) => ({
      currency: balance.currency?.code ?? "",
      cash: parseNumber(balance.cash),
      buyingPower: parseNumber(balance.buying_power),
    }));

  const holdings = positions.results
    .map(normalizeHolding)
    .sort((a, b) => (b.marketValue ?? -Infinity) - (a.marketValue ?? -Infinity));

  const asOf = positions.data_freshness?.as_of ? new Date(positions.data_freshness.as_of) : null;
  return {
    accountId,
    balances: cash,
    holdings,
    dataAsOf: asOf && !Number.isNaN(asOf.getTime()) ? asOf.toISOString() : null,
    fetchedAt: fetchedAt.toISOString(),
  };
}
