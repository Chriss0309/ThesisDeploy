import type { OverlapStatus } from "@/lib/overlap";
import type { BasketCurrency, OverlapMode, RiskProfile } from "@/lib/thesis/schema";

// The Thesis Studio payload. Client components import these types, so this
// module must stay free of server-only imports.

export type CandidateStatus =
  | "resolved"
  | "not_found"
  | "untradeable"
  | "currency_mismatch"
  | "no_price"
  | "duplicate"
  | "invalid";

export type QuoteSnapshot = { last: number | null; bid: number | null; ask: number | null };

export type OverlapHolding = {
  accountName: string;
  symbol: string;
  marketValue: number;
  currency: string;
  /** False when the holding is in another currency and has no FX rate. */
  counted: boolean;
};

export type ComposerLine = {
  symbol: string;
  companyName: string;
  exchange: string | null;
  universalSymbolId: string;
  rationale: string;
  holdingNote: string | null;
  price: number;
  priceBasis: "ask" | "last";
  quote: QuoteSnapshot;
  /** Claude's weight, renormalized over the names that resolved. */
  llmWeight: number;
  /** Weight after the overlap rule; the composer's starting point. */
  targetWeight: number;
  /** Whole shares from the server-side solve. */
  units: number;
  overlap: {
    status: OverlapStatus;
    /** Counted holdings, in the basket currency. */
    heldValue: number;
    /** heldValue as a share of all holdings and cash in the basket currency. */
    heldShare: number | null;
    holdings: OverlapHolding[];
  };
};

export type DroppedCandidate = {
  ticker: string;
  companyName: string;
  status: Exclude<CandidateStatus, "resolved">;
  detail: string;
};

export type ThesisSource = "generated" | "cached" | "sample";

export type ComposerPayload = {
  thesis: {
    /** Null for guest demo theses, which accept no edits telemetry. */
    id: string | null;
    title: string;
    summary: string;
    riskProfile: RiskProfile;
    prompt: string;
    presetKey: string | null;
    model: string;
    latencyMs: number | null;
    source: ThesisSource;
    generatedAt: string;
  };
  account: { id: string; name: string; institution: string; isPaper: boolean };
  currency: BasketCurrency;
  budget: number;
  overlapMode: OverlapMode;
  slippageBuffer: number;
  pricing: {
    source: "snaptrade" | "demo";
    market: "NYSE" | "TSX";
    marketOpen: boolean;
    asOf: string;
  };
  lines: ComposerLine[];
  dropped: DroppedCandidate[];
  excluded: { ticker: string; reason: string }[];
  notices: string[];
};

export type StudioAccount = {
  id: string;
  name: string;
  institution: string;
  maskedNumber: string;
  isPaper: boolean;
  capability: "trade" | "read_only" | "disabled";
  /** Null when balances couldn't be loaded. */
  cash: { currency: string; amount: number }[] | null;
};

export type ThesisErrorBody = {
  error: { code: string; message: string; retryAfterSeconds?: number | null };
};
