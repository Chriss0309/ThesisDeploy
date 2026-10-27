import type { BasketCurrency, RiskProfile } from "@/lib/thesis/schema";

// Pre-flight and execution payloads. Client components import these, so this
// module must stay free of server-only imports.

/** SnapTrade recommends at most one trade request per second per account; 100 ms of margin. */
export const PACE_MS = 1100;
/** Quotes older than this must be refreshed before confirming. */
export const PREFLIGHT_TTL_MS = 5 * 60 * 1000;
/** Attempts per leg, including the first. */
export const MAX_LEG_ATTEMPTS = 3;

export type ExecutionMode = "paper" | "live";

export type PreflightOrder = {
  seq: number;
  action: "BUY";
  symbol: string;
  companyName: string;
  universalSymbolId: string | null;
  units: number;
  targetWeight: number;
  price: number;
  priceBasis: "ask" | "last";
  estCost: number;
};

export type PreflightPayload = {
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
  totals: { estCost: number; unallocated: number; overBudget: boolean };
  live: { available: boolean; reasons: string[] };
  /** Where the order prices come from; never a brokerage preview in Paper. */
  impactNote: string;
  disclosures: { paper: string[]; live: string[] };
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

export type ExecutionStatus = "queued" | "running" | "completed" | "partial" | "failed" | "canceled";

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
  kind: "deploy";
  mode: ExecutionMode;
  status: ExecutionStatus;
  currency: string;
  accountName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  simulateRejectSeq: number | null;
  /** Every attempt, ordered by seq then attempt. */
  legs: LegView[];
};

export type BasketConstituentView = {
  symbol: string;
  companyName: string;
  targetWeight: number;
  plannedUnits: number;
  ledgerUnits: number;
  costTotal: number;
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
