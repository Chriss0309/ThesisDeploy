import { normalizeWeights } from "@/lib/solver";
import {
  MAX_CANDIDATES,
  type BasketCurrency,
  type RiskProfile,
  type ThesisOutput,
} from "@/lib/thesis/schema";
import type { DroppedCandidate } from "@/lib/thesis/types";

export const MAX_RATIONALE_LENGTH = 200;

export type ProposedCandidate = {
  /** As Claude wrote it, trimmed. */
  ticker: string;
  /** Normalized ticker without an exchange suffix: "CCJ", "BRK.B", "TECK.B". */
  base: string;
  listing: "US" | "TSX";
  companyName: string;
  rationale: string;
  /** Normalized over the proposals that survive this step. */
  weight: number;
  holdingNote: string | null;
};

export type NormalizedThesis = {
  onTopic: boolean;
  title: string;
  summary: string;
  riskProfile: RiskProfile;
  candidates: ProposedCandidate[];
  rejected: DroppedCandidate[];
  excluded: { ticker: string; reason: string }[];
};

const EXCHANGE_PREFIX = /^(NYSE|NASDAQ|NYSEARCA|NYSEAMERICAN|AMEX|TSX|TSE):\s*/;
const TSX_SUFFIX = /\.(TO|TSX)$/;
// Ticker roots plus up to two dotted class or series parts (HPS.A, ECF.PRA, HBND.U).
const TICKER = /^[A-Z0-9]{1,6}(\.[A-Z0-9]{1,4}){0,2}$/;

/** "$brk-b", "NYSE: BRK/B", and "BRK B" all become "BRK.B"; "CCJ.TO" becomes "CCJ". */
export function parseTicker(input: string): string | null {
  let ticker = input.trim().toUpperCase().replace(/^\$/, "").replace(EXCHANGE_PREFIX, "");
  ticker = ticker.replace(TSX_SUFFIX, "").replace(/[\s/-]+/g, ".");
  return TICKER.test(ticker) ? ticker : null;
}

/** Baskets are single-currency: CAD buys TSX listings, USD buys US listings. */
export function tickerForCurrency(base: string, currency: BasketCurrency): string {
  return currency === "CAD" ? `${base}.TO` : base;
}

function clean(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Re-checks what structured outputs can't enforce: ticker shape, duplicates,
 * the candidate cap, text lengths, and weights (positive, renormalized to 1).
 */
export function normalizeOutput(output: ThesisOutput): NormalizedThesis {
  const rejected: DroppedCandidate[] = [];
  const kept: Omit<ProposedCandidate, "weight">[] = [];
  const rawWeights: number[] = [];
  const seen = new Set<string>();

  for (const candidate of output.candidates) {
    const ticker = candidate.ticker.trim();
    const companyName = clean(candidate.company_name, 80) || ticker;
    const drop = (status: DroppedCandidate["status"], detail: string) =>
      rejected.push({ ticker, companyName, status, detail });

    const base = parseTicker(ticker);
    if (!base) {
      drop("invalid", "Not a valid ticker");
      continue;
    }
    if (seen.has(base)) {
      drop("duplicate", "Proposed more than once");
      continue;
    }
    if (!(Number.isFinite(candidate.weight_pct) && candidate.weight_pct > 0)) {
      drop("invalid", "No positive target weight");
      continue;
    }
    if (kept.length >= MAX_CANDIDATES) {
      drop("invalid", `Over the ${MAX_CANDIDATES}-candidate limit`);
      continue;
    }
    seen.add(base);
    kept.push({
      ticker,
      base,
      listing: candidate.listing,
      companyName,
      rationale: clean(candidate.rationale, MAX_RATIONALE_LENGTH),
      holdingNote: candidate.holding_note ? clean(candidate.holding_note, 160) : null,
    });
    rawWeights.push(candidate.weight_pct);
  }

  const weights = normalizeWeights(rawWeights);
  return {
    onTopic: output.on_topic,
    title: clean(output.title, 80) || "Untitled thesis",
    summary: clean(output.summary, 300),
    riskProfile: output.risk_profile,
    candidates: kept.map((candidate, i) => ({ ...candidate, weight: weights[i] })),
    rejected,
    excluded: output.excluded.slice(0, 8).map((entry) => ({
      ticker: clean(entry.ticker, 16).toUpperCase(),
      reason: clean(entry.reason, 160),
    })),
  };
}
