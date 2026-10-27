export function formatMoney(amount: number | null | undefined, currency: string): string {
  if (amount == null) return "—";
  try {
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(amount);
    return `${formatted} ${currency}`;
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export const formatPercent = (weight: number) => `${(weight * 100).toFixed(1)}%`;

export const formatUnits = (units: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(units);

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(iso)) + " UTC";
}

const MINUS = "\u2212";

/** Signed percentage points of weight, `+2.4 pts` / `−5.1 pts`. */
export function formatPoints(fraction: number): string {
  const points = Math.round(fraction * 1000) / 10;
  return `${points > 0 ? "+" : points < 0 ? MINUS : ""}${Math.abs(points).toFixed(1)} pts`;
}

/** A gain or loss with an explicit sign and a typographic minus: `+$12.00 USD`, `−$14.00 USD`. */
export function formatMoneyDelta(amount: number | null | undefined, currency: string): string {
  if (amount == null) return "—";
  const rounded = Math.round(amount * 100) / 100;
  const money = formatMoney(Math.abs(rounded), currency);
  return rounded > 0 ? `+${money}` : rounded < 0 ? `${MINUS}${money}` : money;
}

export function formatPercentDelta(fraction: number | null | undefined): string {
  if (fraction == null) return "—";
  const percent = Math.round(fraction * 1000) / 10;
  return `${percent > 0 ? "+" : percent < 0 ? MINUS : ""}${Math.abs(percent).toFixed(1)}%`;
}

/** Tone class for a gain or loss; zero and unknown stay neutral. */
export const deltaTone = (amount: number | null | undefined) =>
  amount == null || Math.round(amount * 100) === 0
    ? "text-muted-foreground"
    : amount > 0
      ? "text-positive-subtle-foreground"
      : "text-negative-subtle-foreground";
