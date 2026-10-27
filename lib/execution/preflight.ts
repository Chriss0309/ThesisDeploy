import { formatMoney } from "@/components/portfolio/format";
import type { PreflightLine, PreflightOrder, PreflightPayload } from "@/lib/execution/types";
import type { MarketStatus } from "@/lib/market-hours";
import type { Capability } from "@/lib/portfolio/types";
import { EPSILON, normalizeWeights, type Quote } from "@/lib/solver";

// Pure pre-flight: the exact order list at fresh prices, plus every reason
// Live is unavailable. Paper is always available.

export type PreflightInput = {
  lines: readonly PreflightLine[];
  quotes: ReadonlyMap<string, Quote>;
  market: MarketStatus;
  budget: number;
  currency: string;
  account: {
    id: string;
    name: string;
    institution: string;
    isPaper: boolean;
    capability: Capability;
    capabilityReason: string;
  };
  /** Cash in the basket currency from the cached snapshot; null when unknown. */
  cash: number | null;
  liveTradingEnabled: boolean;
  guest: boolean;
  priceSource: "snaptrade" | "demo";
};

const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Buys at the ask while the market is open, otherwise the last trade (like `executionPrice`). */
export function buyPrice(quote: Quote, marketOpen: boolean): { price: number; basis: "ask" | "last" } | null {
  const order: ["ask" | "last", number | null | undefined][] = marketOpen
    ? [["ask", quote.ask], ["last", quote.last]]
    : [["last", quote.last], ["ask", quote.ask]];
  for (const [basis, price] of order) {
    if (positive(price)) return { price, basis };
  }
  return null;
}

const CLOSED_REASON: Record<string, string> = {
  weekend: "weekend",
  pre_open: "before the open",
  after_close: "after the close",
  no_calendar: "no trading calendar for this date",
};

const eastern = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

export function marketNote(market: MarketStatus): string {
  if (market.open) return `${market.market} is open: buys are priced at the ask.`;
  const why = market.reason === "holiday" ? (market.holiday ?? "holiday") : CLOSED_REASON[market.reason];
  const next = market.nextOpen ? ` Opens ${eastern.format(market.nextOpen)} ET.` : "";
  return `${market.market} is closed (${why}): prices are the last trade.${next}`;
}

export function liveReasons(input: PreflightInput, estCost: number): string[] {
  const reasons: string[] = [];
  if (input.guest) reasons.push("Demo accounts are fictional. Sign in with SnapTrade to trade your own account.");
  reasons.push(
    input.liveTradingEnabled
      ? "Live order submission ships in a later release. Paper runs the same paced queue without sending orders."
      : "Live trading is switched off on this deployment.",
  );
  if (!input.guest && input.account.capability !== "trade") reasons.push(input.account.capabilityReason);
  if (!input.market.open) {
    reasons.push(`${input.market.market} is closed, and Live market orders are blocked outside the regular session.`);
  }
  if (!input.guest) {
    if (input.cash == null) {
      reasons.push(`This account's ${input.currency} cash couldn't be confirmed.`);
    } else if (estCost > input.cash + EPSILON) {
      reasons.push(
        `The orders need about ${formatMoney(estCost, input.currency)}; the account has ${formatMoney(input.cash, input.currency)} in cash.`,
      );
    }
  }
  return reasons;
}

export function buildPreflight(
  input: PreflightInput,
): Omit<PreflightPayload, "basketId" | "preparedAt" | "expiresAt" | "title"> {
  const leftOut: PreflightPayload["leftOut"] = [];
  const priced: (PreflightLine & { price: number; basis: "ask" | "last" })[] = [];
  for (const line of input.lines) {
    if (line.units <= 0) {
      leftOut.push({ symbol: line.symbol, reason: "0 shares in the composer" });
      continue;
    }
    const quote = input.quotes.get(line.symbol);
    const price = quote ? buyPrice(quote, input.market.open) : null;
    if (!price) {
      leftOut.push({
        symbol: line.symbol,
        reason: input.priceSource === "demo" ? "No demo quote" : "SnapTrade returned no price",
      });
      continue;
    }
    priced.push({ ...line, price: price.price, basis: price.basis });
  }

  const weights = normalizeWeights(priced.map((line) => line.targetWeight));
  const orders: PreflightOrder[] = priced.map((line, i) => ({
    seq: i + 1,
    action: "BUY",
    symbol: line.symbol,
    companyName: line.companyName,
    universalSymbolId: line.universalSymbolId,
    units: line.units,
    targetWeight: weights[i],
    price: line.price,
    priceBasis: line.basis,
    estCost: line.units * line.price,
  }));
  const estCost = orders.reduce((sum, order) => sum + order.estCost, 0);
  const reasons = liveReasons(input, estCost);
  const { institution } = input.account;

  return {
    account: { id: input.account.id, name: input.account.name, institution, isPaper: input.account.isPaper },
    currency: input.currency as PreflightPayload["currency"],
    budget: input.budget,
    priceSource: input.priceSource,
    market: { name: input.market.market, open: input.market.open, note: marketNote(input.market) },
    orders,
    leftOut,
    totals: { estCost, unallocated: input.budget - estCost, overBudget: estCost > input.budget + EPSILON },
    live: { available: reasons.length === 0, reasons },
    impactNote:
      input.priceSource === "demo"
        ? "App estimate from fictional demo quotes. Paper fills have no commission."
        : "App estimate from SnapTrade quotes, which may be delayed; no brokerage order preview. Paper fills have no commission.",
    disclosures: {
      paper: [
        `Paper simulation: nothing is sent to ${institution}. Each leg fills in full at its pre-flight price; real market orders can fill higher or lower, partly, or not at all.`,
        "Legs are paced at one per second per account, exactly like live orders, and the result is saved as a Paper basket kept apart from your real holdings.",
      ],
      live: [
        "Market orders fill at the next available price, which can differ from these quotes.",
        "Commissions and fees: not available. No brokerage preview was requested, so they are not shown as zero.",
        "Orders go to your brokerage through SnapTrade and can't be undone here. Not investment advice.",
      ],
    },
  };
}
