import type {
  AllAccountPositionsResponse,
  AllUserAccountsResponse,
  Balance,
  BrokerageAuthorization,
} from "snaptrade-typescript-sdk";

import raw from "@/lib/portfolio/demo-fixtures.json";
import { normalizeAccounts, normalizeSnapshot } from "@/lib/portfolio/normalize";
import type { AccountSnapshot, PortfolioOverview } from "@/lib/portfolio/types";

// Fictional data in SnapTrade's response shapes, so the guest demo, the stub
// API server, and live data all go through the same normalization.
export type DemoFixtures = {
  connections: BrokerageAuthorization[];
  accounts: AllUserAccountsResponse;
  balances: Record<string, Balance[]>;
  positions: Record<string, AllAccountPositionsResponse>;
};

export const DEMO_FIXTURES = raw as unknown as DemoFixtures;

const DEMO_SCOPES = ["openid", "email", "profile", "read", "trade"];

export function demoOverview(): PortfolioOverview {
  return normalizeAccounts(DEMO_FIXTURES.connections, DEMO_FIXTURES.accounts, DEMO_SCOPES);
}

export function demoSnapshot(accountId: string): AccountSnapshot | null {
  const balances = DEMO_FIXTURES.balances[accountId];
  const positions = DEMO_FIXTURES.positions[accountId];
  if (!balances || !positions) return null;
  return normalizeSnapshot(accountId, balances, positions, new Date(positions.data_freshness.as_of));
}
