import { liveDisclosures, liveGate, type LiveGateInput } from "@/lib/execution/live-gate";
import { marketNote } from "@/lib/execution/market-text";
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
  /** Fresh buying power in the basket currency, fetched only when Live could otherwise run; null when unknown. */
  buyingPower: number | null;
  killSwitch: LiveGateInput["killSwitch"];
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

export { marketNote };

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
  const { institution } = input.account;
  const gate = liveGate({
    kind: "deploy",
    guest: input.guest,
    killSwitch: input.killSwitch,
    institution,
    account: input.account,
    basketMode: null,
    market: input.market,
    currency: input.currency,
    buyCost: estCost,
    sellProceeds: 0,
    buyingPower: input.buyingPower,
    shortfalls: [],
  });

  return {
    account: { id: input.account.id, name: input.account.name, institution, isPaper: input.account.isPaper },
    currency: input.currency as PreflightPayload["currency"],
    budget: input.budget,
    priceSource: input.priceSource,
    market: { name: input.market.market, open: input.market.open, note: marketNote(input.market) },
    orders,
    leftOut,
    totals: { estCost, unallocated: input.budget - estCost, overBudget: estCost > input.budget + EPSILON },
    live: { available: gate.available, reasons: gate.reasons, notes: gate.notes, buyingPower: input.buyingPower },
    impactNote:
      input.priceSource === "demo"
        ? "App estimate from fictional demo quotes. Paper fills have no commission."
        : "App estimate from SnapTrade quotes, which may be delayed; no brokerage order preview. Paper fills have no commission.",
    disclosures: {
      paper: [
        `Paper simulation: nothing is sent to ${institution}. Each leg fills in full at its pre-flight price; real market orders can fill higher or lower, partly, or not at all.`,
        "Legs are paced at one per second per account, exactly like live orders, and the result is saved as a Paper basket kept apart from your real holdings.",
      ],
      live: liveDisclosures(institution),
    },
  };
}
