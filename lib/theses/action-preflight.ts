import { formatMoney } from "@/components/portfolio/format";
import { computeDrift, planClose, planRebalance, type BasketPosition, type TradeLeg } from "@/lib/drift";
import type { PreflightOrder, PreflightPayload } from "@/lib/execution/types";
import { marketNote } from "@/lib/execution/preflight";
import type { MarketStatus } from "@/lib/market-hours";
import { EPSILON } from "@/lib/solver";
import type { Marks, PriceMark } from "@/lib/theses/types";
import { positionsFrom, type HeldConstituent } from "@/lib/theses/valuation";

// Pure pre-flight for rebalance and close: the exact sells and buys, at fresh
// prices, from the basket ledger.

export type ActionPreflightInput = {
  kind: "rebalance" | "close";
  currency: string;
  account: PreflightPayload["account"];
  constituents: readonly (HeldConstituent & { universalSymbolId: string | null })[];
  marks: Marks;
  market: MarketStatus;
  guest: boolean;
  liveTradingEnabled: boolean;
};

export class ActionPlanError extends Error {
  constructor(
    readonly code: "price_unavailable" | "nothing_to_order",
    message: string,
  ) {
    super(message);
    this.name = "ActionPlanError";
  }
}

function basis(leg: TradeLeg, position: BasketPosition): PreflightOrder["priceBasis"] {
  if (leg.action === "SELL" && leg.estPrice === position.bid) return "bid";
  if (leg.action === "BUY" && leg.estPrice === position.ask) return "ask";
  return "last";
}

function afterUnits(positions: readonly BasketPosition[], legs: readonly TradeLeg[]): BasketPosition[] {
  return positions.map((position) => {
    const delta = legs
      .filter((leg) => leg.symbol === position.symbol)
      .reduce((sum, leg) => sum + (leg.action === "BUY" ? leg.units : -leg.units), 0);
    return { ...position, ledgerUnits: position.ledgerUnits + delta };
  });
}

export function buildActionPreflight(
  input: ActionPreflightInput,
): Omit<PreflightPayload, "basketId" | "preparedAt" | "expiresAt" | "title" | "preflightId"> {
  const prices = new Map<string, PriceMark>(Object.entries(input.marks.prices));
  const positions = positionsFrom(input.constituents, prices);
  if (!positions) {
    const missing = input.constituents.filter((row) => !prices.has(row.symbol)).map((row) => row.symbol);
    throw new ActionPlanError(
      "price_unavailable",
      `${input.marks.source === "demo" ? "The demo feed" : "SnapTrade"} returned no price for ${missing.join(", ") || "a holding"}, so the trades can't be priced.`,
    );
  }
  const marketOpen = input.market.open;
  const before = computeDrift(positions);
  const plan =
    input.kind === "rebalance"
      ? planRebalance(positions, { marketOpen })
      : (() => {
          const legs = planClose(positions, { marketOpen });
          return { legs, sellProceeds: legs.reduce((sum, leg) => sum + leg.estValue, 0), buyCost: 0 };
        })();
  if (plan.legs.length === 0) {
    throw new ActionPlanError(
      "nothing_to_order",
      input.kind === "close"
        ? "This basket holds no whole shares to sell."
        : "Whole shares can't bring this basket any closer to its targets.",
    );
  }

  const bySymbol = new Map(input.constituents.map((row) => [row.symbol, row]));
  const positionBySymbol = new Map(positions.map((position) => [position.symbol, position]));
  const weights = new Map(before.lines.map((line) => [line.symbol, line.targetWeight]));
  const orders: PreflightOrder[] = plan.legs.map((leg, i) => {
    const row = bySymbol.get(leg.symbol)!;
    return {
      seq: i + 1,
      action: leg.action,
      symbol: leg.symbol,
      companyName: row.companyName,
      universalSymbolId: row.universalSymbolId,
      units: leg.units,
      targetWeight: weights.get(leg.symbol) ?? row.targetWeight,
      price: leg.estPrice,
      priceBasis: basis(leg, positionBySymbol.get(leg.symbol)!),
      estCost: leg.estValue,
    };
  });

  const { institution } = input.account;
  const after = computeDrift(afterUnits(positions, plan.legs));
  const liveReasons = [
    ...(input.guest ? ["Demo accounts are fictional. Sign in with SnapTrade to trade your own account."] : []),
    input.liveTradingEnabled
      ? "Live order submission ships in a later release. Paper runs the same paced queue without sending orders."
      : "Live trading is switched off on this deployment.",
    ...(input.market.open ? [] : [`${input.market.market} is closed, and Live market orders are blocked outside the regular session.`]),
  ];
  const sellProceeds = plan.sellProceeds;
  const buyCost = plan.buyCost;
  const unit = input.kind === "close" ? "close" : "rebalance";

  return {
    kind: input.kind,
    account: input.account,
    currency: input.currency as PreflightPayload["currency"],
    budget: sellProceeds,
    priceSource: input.marks.source,
    market: { name: input.market.market, open: input.market.open, note: marketNote(input.market) },
    orders,
    leftOut: [],
    totals: { estCost: buyCost, sellProceeds, unallocated: sellProceeds - buyCost, overBudget: buyCost > sellProceeds + EPSILON },
    rebalance: { maxDriftBefore: before.maxAbsDrift, maxDriftAfter: after.maxAbsDrift, sellProceeds, buyCost },
    live: { available: false, reasons: liveReasons },
    impactNote:
      input.marks.source === "demo"
        ? "App estimate from fictional demo quotes. Sells are priced at the bid and buys at the ask while the market is open. Paper fills have no commission."
        : "App estimate from SnapTrade quotes, which may be delayed; no brokerage order preview. Sells are priced at the bid and buys at the ask while the market is open. Paper fills have no commission.",
    disclosures: {
      paper: [
        `Paper ${unit}: nothing is sent to ${institution}. Each leg fills in full at its pre-flight price; real market orders can fill higher or lower, partly, or not at all.`,
        input.kind === "close"
          ? `Sells come before anything else, one per second per account. Proceeds of ${formatMoney(sellProceeds, input.currency)} stay in the basket's cash, and the basket closes once every share is sold.`
          : "Sells run before buys, one leg per second per account, so the basket stays roughly cash-neutral. The Paper basket is kept apart from your real holdings.",
      ],
      live: [
        "Market orders fill at the next available price, which can differ from these quotes.",
        "Commissions and fees: not available. No brokerage preview was requested, so they are not shown as zero.",
        "Orders go to your brokerage through SnapTrade and can't be undone here. Not investment advice.",
      ],
    },
  };
}
