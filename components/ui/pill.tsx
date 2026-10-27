import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type PillTone = "neutral" | "good" | "warn" | "bad" | "info";

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: PillTone }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium whitespace-nowrap",
        tone === "neutral" && "text-muted-foreground",
        tone === "good" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        tone === "warn" && "border-amber-200 bg-amber-50 text-amber-800",
        tone === "bad" && "border-red-200 bg-red-50 text-red-700",
        tone === "info" && "border-sky-200 bg-sky-50 text-sky-700",
      )}
    >
      {children}
    </span>
  );
}
