import type { MarketStatus } from "@/lib/market-hours";

// Plain-language market status for pre-flight notes and Live gating.

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

/** Why the market is closed: "weekend", "before the open", or the holiday's name. */
export function closedWhy(market: Extract<MarketStatus, { open: false }>): string {
  return market.reason === "holiday" ? (market.holiday ?? "holiday") : CLOSED_REASON[market.reason];
}

/** " Opens Mon, Oct 26, 9:30 AM ET." or "" when the next session is unknown. */
export function opensText(market: Extract<MarketStatus, { open: false }>): string {
  return market.nextOpen ? ` Opens ${eastern.format(market.nextOpen)} ET.` : "";
}

export function marketNote(market: MarketStatus): string {
  if (market.open) return `${market.market} is open: buys are priced at the ask.`;
  return `${market.market} is closed (${closedWhy(market)}): prices are the last trade.${opensText(market)}`;
}
