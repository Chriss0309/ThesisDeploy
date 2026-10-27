import { formatMoney, formatPercent } from "@/components/portfolio/format";
import { StatusBadge, type StatusTone } from "@/components/thesis/status-badge";
import type { ComposerLine } from "@/lib/thesis/types";
import { cn } from "@/lib/utils";

function joinNames(names: string[]) {
  const unique = [...new Set(names)];
  return unique.length <= 1 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

/** The overlap rule's verdict for one line, as decided by the server when the basket was built. */
export function OverlapBadge({ line, currency, budget }: { line: ComposerLine; currency: string; budget: number }) {
  const { overlap } = line;
  const counted = overlap.holdings.filter((holding) => holding.counted);
  const accounts = joinNames(counted.map((holding) => holding.accountName));
  const held = `You already hold ${formatMoney(overlap.heldValue, currency)}${
    overlap.heldShare != null ? ` (${formatPercent(overlap.heldShare)} of your ${currency} portfolio)` : ""
  } of ${line.symbol} in ${accounts}.`;

  let tone: StatusTone = "positive";
  let label = "New exposure";
  let detail: string | null = null;
  switch (overlap.status) {
    case "adjusted":
      tone = "attention";
      label = "Overlap adjusted";
      detail = `${held} Target weight reduced from ${formatPercent(line.llmWeight)} to ${formatPercent(line.targetWeight)}.`;
      break;
    case "fully_held":
      tone = "attention";
      label = "Already held at target";
      detail = `${held} That covers this name's ${formatMoney(line.llmWeight * budget, currency)} target, so it starts at 0%. Raise the weight to buy more anyway.`;
      break;
    case "ignored":
      tone = "neutral";
      label = "Overlap ignored";
      detail = `${held} Sized as if you held none, because overlap handling is off.`;
      break;
    case "unconverted": {
      tone = "neutral";
      label = "Held in another currency";
      const other = overlap.holdings
        .map((holding) => `${formatMoney(holding.marketValue, holding.currency)} of ${holding.symbol} in ${holding.accountName}`)
        .join("; ");
      detail = `You hold ${other}. Not netted against this ${currency} basket because there's no FX rate.`;
      break;
    }
  }

  return (
    <div className={cn("flex flex-col items-start gap-1 text-xs", tone === "attention" ? "text-foreground" : "text-muted-foreground")}>
      <StatusBadge tone={tone}>{label}</StatusBadge>
      {detail && <p className="text-pretty">{detail}</p>}
    </div>
  );
}
