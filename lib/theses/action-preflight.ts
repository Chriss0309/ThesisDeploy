import { formatMoney } from "@/components/portfolio/format";
import { computeDrift, planClose, planRebalance, type BasketPosition, type TradeLeg } from "@/lib/drift";
import { liveDisclosures, liveGate, paperGate, type LiveGateInput } from "@/lib/execution/live-gate";
import { marketNote } from "@/lib/execution/market-text";
import type { ExecutionMode, PreflightOrder, PreflightPayload } from "@/lib/execution/types";
import type { Capability } from "@/lib/portfolio/types";
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
  killSwitch: LiveGateInput["killSwitch"];
  basketMode: ExecutionMode | null;
  /** Re-read from SnapTrade for Live baskets; null otherwise. */
  capability: { capability: Capability; capabilityReason: string } | null;
  buyingPower: number | null;
  /** Live baskets: whole shares the broker holds per symbol; null when not checked. */
  held: ReadonlyMap<string, number> | null;
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
  // A Live close sells only what the broker actually holds; a rebalance that would oversell is blocked below.
  const shortfalls = input.held
    ? plan.legs.flatMap((leg) => {
        const held = Math.max(0, Math.floor(input.held!.get(leg.symbol) ?? 0));
        return leg.action === "SELL" && leg.units > held ? [{ symbol: leg.symbol, selling: leg.units, held }] : [];
      })
    : [];
  if (input.kind === "close" && shortfalls.length > 0) {
    const cap = new Map(shortfalls.map((short) => [short.symbol, short.held]));
    plan.legs = plan.legs.flatMap((leg) => {
      const units = Math.min(leg.units, cap.get(leg.symbol) ?? leg.units);
      return units > 0 ? [{ ...leg, units, estValue: units * leg.estPrice }] : [];
    });
    plan.sellProceeds = plan.legs.reduce((sum, leg) => sum + leg.estValue, 0);
  }
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
  const sellProceeds = plan.sellProceeds;
  const buyCost = plan.buyCost;
  const gate = liveGate({
    kind: input.kind,
    guest: input.guest,
    killSwitch: input.killSwitch,
    institution,
    account: input.capability,
    basketMode: input.basketMode,
    market: input.market,
    currency: input.currency,
    buyCost,
    sellProceeds,
    buyingPower: input.buyingPower,
    shortfalls,
  });
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
    live: { available: gate.available, reasons: gate.reasons, notes: gate.notes, buyingPower: input.buyingPower },
    paper: paperGate(input.kind, input.basketMode, institution),
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
        ...liveDisclosures(institution),
        input.kind === "close"
          ? "Sells run one second apart. The basket closes once every share has filled at the broker."
          : "Sells run before buys, one second apart. Buys wait for nothing: if a sell hasn't filled yet, the buy still goes out.",
      ],
    },
  };
}
