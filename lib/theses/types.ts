import type { ExecutionView } from "@/lib/execution/types";
import type { RiskProfile } from "@/lib/thesis/schema";

// My Theses view models. Client components import these, so this module must
// stay free of server-only imports.

export type PriceMark = { last: number | null; bid: number | null; ask: number | null };

/** Prices a basket is valued at, keyed by ticker. */
export type Marks = {
  source: "snaptrade" | "demo";
  asOf: string;
  prices: Record<string, PriceMark>;
};

export type ThesisLine = {
  symbol: string;
  companyName: string;
  /** Normalized target weight, a fraction. */
  targetWeight: number;
  units: number;
  price: number | null;
  value: number | null;
  /** Cost basis of the shares held (average cost). */
  costBasis: number;
  unrealized: number | null;
  currentWeight: number;
  /** Current minus target weight, a fraction (0.05 = 5 points). */
  drift: number;
};

export type ThesisValuation = {
  holdingsValue: number;
  costBasis: number;
  unrealized: number;
  realized: number;
  cash: number;
  /** Holdings plus cash. */
  totalValue: number;
  contributed: number;
  /** Total value less what the deploy put in. */
  totalReturn: number;
  totalReturnPct: number | null;
  unrealizedPct: number | null;
  maxAbsDrift: number;
  threshold: number;
  rebalanceRecommended: boolean;
  lines: ThesisLine[];
};

export type ThesisCard = {
  id: string;
  title: string;
  summary: string;
  riskProfile: RiskProfile;
  status: "deploying" | "active" | "closed";
  currency: string;
  accountName: string;
  institution: string;
  deployedAt: string | null;
  closedAt: string | null;
  mode: "paper" | "live" | null;
  budget: number;
  contributed: number;
  /** Null while prices are unavailable. */
  valuation: ThesisValuation | null;
  pricing: {
    source: "snaptrade" | "demo";
    asOf: string | null;
    /** Cached prices shown because a fresh quote failed. */
    stale: boolean;
    problem: string | null;
  };
  /** The latest rebalance or close run, while it can still move. */
  execution: ExecutionView | null;
  /** Guest demo only: the multipliers applied by the reviewer tool. */
  simulatedMoves: Record<string, number> | null;
  basketPath: string;
};
