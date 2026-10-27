import type { BasketCurrency, RiskProfile } from "@/lib/thesis/schema";

// Pre-flight and execution payloads. Client components import these, so this
// module must stay free of server-only imports.

/** SnapTrade recommends at most one trade request per second per account; 100 ms of margin. */
export const PACE_MS = 1100;
/** Quotes older than this must be refreshed before confirming. */
export const PREFLIGHT_TTL_MS = 5 * 60 * 1000;
/** Attempts per leg, including the first. */
export const MAX_LEG_ATTEMPTS = 3;
/** SnapTrade asks for order-status polling no more often than every 15 seconds per account. */
export const RECONCILE_INTERVAL_MS = 15_000;

export type ExecutionMode = "paper" | "live";
/** A deploy buys a new basket; rebalance and close sell and buy against its ledger. */
export type ExecutionKind = "deploy" | "rebalance" | "close";

export type PreflightOrder = {
  seq: number;
  action: "BUY" | "SELL";
  symbol: string;
  companyName: string;
  universalSymbolId: string | null;
  units: number;
  targetWeight: number;
  price: number;
  priceBasis: "ask" | "bid" | "last";
  /** units × price: the cost of a buy, the proceeds of a sell. */
  estCost: number;
};

/** What a rebalance moves, for the pre-flight summary. Weights are fractions. */
export type RebalanceSummary = {
  maxDriftBefore: number;
  maxDriftAfter: number;
  sellProceeds: number;
  buyCost: number;
};

export type PreflightPayload = {
  /** Absent on payloads saved before My Theses, which are all deploys. */
  kind?: ExecutionKind;
  /** Rebalance and close only: each pre-flight can be confirmed once. */
  preflightId?: string;
  rebalance?: RebalanceSummary;
  basketId: string;
  preparedAt: string;
  expiresAt: string;
  account: { id: string; name: string; institution: string; isPaper: boolean };
  currency: BasketCurrency;
  budget: number;
  title: string;
  priceSource: "snaptrade" | "demo";
  market: { name: "NYSE" | "TSX"; open: boolean; note: string };
  orders: PreflightOrder[];
  /** Lines in the composer that get no order, with the reason. */
  leftOut: { symbol: string; reason: string }[];
  totals: { estCost: number; unallocated: number; overBudget: boolean; sellProceeds?: number };
  live: ModeGate & {
    /** Warnings that don't block Live, shown when it's selected. */
    notes?: string[];
    /** Buying power in the basket currency from a fresh balance call, when Live was checked. */
    buyingPower?: number | null;
  };
  /** Absent means available. A Live basket is rebalanced and closed only Live, so ledgers never mix. */
  paper?: ModeGate;
  /** Where the order prices come from; never a brokerage preview in Paper. */
  impactNote: string;
  /** The brokerage preview, once requested for Live. */
  impact?: ImpactCheck;
  disclosures: { paper: string[]; live: string[] };
};

export type ModeGate = { available: boolean; reasons: string[] };

/**
 * SnapTrade's order impact per leg. `brokerage` means the broker previewed
 * every leg; `unsupported` means it has no preview for this account;
 * `unavailable` means the preview failed for at least one leg.
 */
export type ImpactCheck = {
  source: "brokerage" | "unsupported" | "unavailable";
  checkedAt: string;
  legs: ImpactLeg[];
  /** Sum of the legs' estimated commissions, when every leg returned one. */
  totalCommission: number | null;
  totalForexFees: number | null;
  /** The broker's estimate of cash left after the last previewed leg. */
  remainingCash: number | null;
};

export type ImpactLeg = {
  seq: number;
  status: "ok" | "rejected" | "unavailable";
  estimatedCommission: number | null;
  forexFees: number | null;
  remainingCash: number | null;
  message: string | null;
};

export type PreflightLine = {
  symbol: string;
  companyName: string;
  universalSymbolId: string | null;
  targetWeight: number;
  units: number;
};

export type PreflightRequest = {
  basketId?: string | null;
  thesisId: string | null;
  accountId: string;
  currency: BasketCurrency;
  budget: number;
  thesis: { title: string; summary: string; riskProfile: RiskProfile };
  lines: PreflightLine[];
};

export type LegStatus =
  | "pending"
  | "claimed"
  | "executed"
  | "accepted"
  | "partial"
  | "rejected"
  | "failed"
  | "unknown"
  | "skipped";

export type ActionRequest = { kind: "rebalance" | "close" };

/** `working`: every leg was sent, and Live orders are still open at the broker. */
export type ExecutionStatus = "queued" | "running" | "working" | "completed" | "partial" | "failed" | "canceled";

export type LegView = {
  id: string;
  seq: number;
  attempt: number;
  action: "BUY" | "SELL";
  symbol: string;
  units: number;
  estPrice: number;
  status: LegStatus;
  brokerageOrderId: string | null;
  /** SnapTrade's order status for Live legs (ACCEPTED, EXECUTED, …). */
  snaptradeStatus?: string | null;
  filledUnits: number | null;
  fillPrice: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  claimedAt: string | null;
  submittedAt: string | null;
};

export type ExecutionView = {
  id: string;
  basketId: string;
  basketPath: string;
  kind: ExecutionKind;
  mode: ExecutionMode;
  status: ExecutionStatus;
  currency: string;
  accountName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  simulateRejectSeq: number | null;
  /** Live on a broker's paper-trading account (e.g. Alpaca Paper). */
  paperAccount: boolean;
  institution: string;
  /** Last order-status check at the broker (Live only). */
  reconciledAt: string | null;
  /** Every attempt, ordered by seq then attempt. */
  legs: LegView[];
};

export type BasketConstituentView = {
  symbol: string;
  companyName: string;
  targetWeight: number;
  plannedUnits: number;
  ledgerUnits: number;
  /** Cost basis of the shares still held. */
  costTotal: number;
  realizedTotal: number;
};

export type BasketView = {
  id: string;
  title: string;
  summary: string;
  riskProfile: RiskProfile;
  mode: ExecutionMode | null;
  status: "draft" | "deploying" | "active" | "closed";
  currency: string;
  budget: number;
  account: { name: string; institution: string };
  priceSource: "snaptrade" | "demo";
  createdAt: string;
  deployedAt: string | null;
  closedAt: string | null;
  /** What the deploy put in; proceeds of later sells less rebalance buys sit in `cash`. */
  contributed: number;
  cash: number;
  constituents: BasketConstituentView[];
  execution: ExecutionView | null;
};

/** One NDJSON line from `POST /api/executions/:id/drain`. */
export type DrainEvent =
  | { type: "leg"; leg: LegView }
  | { type: "pacing"; waitMs: number }
  | {
      type: "done";
      execution: ExecutionView;
      /** Why this drain stopped; the client drains again while legs are pending. */
      reason: "finished" | "time_budget" | "aborted" | "waiting";
    }
  | { type: "error"; code: string; message: string };

export type ExecutionErrorBody = {
  error: { code: string; message: string; retryAfterSeconds?: number | null; executionId?: string | null };
};
