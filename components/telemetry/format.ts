import { formatPercent } from "@/components/portfolio/format";

/** A share in [0, 1], or null when there is nothing to divide by. */
export const rate = (part: number, whole: number | null): number | null =>
  whole == null || whole <= 0 ? null : Math.min(1, Math.max(0, part / whole));

/** One decimal, or an em dash when the rate is undefined. */
export const formatRate = (value: number | null) => (value == null ? "—" : formatPercent(value));

export const formatCount = (value: number) => new Intl.NumberFormat("en-US").format(value);

export const formatMs = (value: number) => `${formatCount(value)} ms`;

const DROP_REASONS: Record<string, string> = {
  not_found: "not found",
  untradeable: "untradeable",
  currency_mismatch: "wrong currency",
  no_price: "no price",
  duplicate: "duplicate",
  invalid: "invalid ticker",
};

export const dropReason = (reason: string) => DROP_REASONS[reason] ?? reason.replaceAll("_", " ");
