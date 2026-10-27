import { formatPercent, formatPoints } from "@/components/portfolio/format";
import { cn } from "@/lib/utils";

/**
 * Current weight (brand fill) against its target (ink tick), with the gap
 * shaded over or under. `scale` is the weight the full track stands for, so
 * every row in a card shares one axis.
 */
export function DriftBar({
  symbol,
  current,
  target,
  scale,
  className,
}: {
  symbol: string;
  current: number;
  target: number;
  scale: number;
  className?: string;
}) {
  const at = (weight: number) => `${Math.max(0, Math.min(1, weight / scale)) * 100}%`;
  const over = current >= target;
  const low = Math.min(current, target);
  const high = Math.max(current, target);
  return (
    <div
      role="img"
      aria-label={`${symbol}: ${formatPercent(current)} now, ${formatPercent(target)} target, ${formatPoints(current - target)}`}
      className={cn("relative h-1.5 rounded-full bg-chart-track", className)}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: at(current) }} />
      <div
        className={cn("absolute inset-y-0", over ? "bg-drift-over/60" : "bg-drift-under/60")}
        style={{ left: at(low), width: `${Math.max(0, Math.min(1, (high - low) / scale)) * 100}%` }}
      />
      <div className="absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-chart-target" style={{ left: at(target) }} />
    </div>
  );
}
