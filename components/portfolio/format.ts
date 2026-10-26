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
