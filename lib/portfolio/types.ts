export type Capability = "trade" | "read_only" | "disabled";

export type Money = { amount: number; currency: string };

export type PortfolioAccount = {
  id: string;
  name: string;
  institution: string;
  brokerageSlug: string | null;
  maskedNumber: string;
  connectionId: string;
  isPaper: boolean;
  cashOrMargin: "cash" | "margin" | "unknown";
  netValue: Money | null;
  capability: Capability;
  capabilityReason: string;
};

export type CashBalance = {
  currency: string;
  cash: number | null;
  buyingPower: number | null;
};

export type Holding = {
  symbol: string;
  description: string | null;
  kind: string;
  currency: string | null;
  units: number;
  price: number | null;
  marketValue: number | null;
  /** Already counted in the account's cash balance by the brokerage. */
  cashEquivalent: boolean;
  figiShareClass: string | null;
};

export type AccountSnapshot = {
  accountId: string;
  balances: CashBalance[];
  holdings: Holding[];
  dataAsOf: string | null;
  fetchedAt: string;
};

export type PortfolioOverview = {
  accounts: PortfolioAccount[];
  /** Non-investment accounts (deposit, line of credit, annuity) are not shown. */
  hiddenAccounts: number;
};
