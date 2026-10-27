import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StatusTone = "neutral" | "positive" | "attention" | "negative";

// Theme tokens only, so a design system can restyle every Studio status here.
const TONES: Record<StatusTone, string> = {
  neutral: "border-border text-muted-foreground",
  positive: "border-transparent bg-secondary text-secondary-foreground",
  attention: "border-transparent bg-primary text-primary-foreground",
  negative: "border-destructive/30 text-destructive",
};

export function StatusBadge({ tone = "neutral", children }: { tone?: StatusTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
