"use client";

import { Loader, type ExecutionLeg } from "@/components/loader/loader";

/**
 * Every loading and in-progress visual for pre-flight and execution renders
 * through this component: the shared `stacks` loader, one stack per order leg.
 */
export function ExecutionLoader({
  label,
  legs,
  settled,
  onSettled,
}: {
  label: string;
  legs: ExecutionLeg[];
  settled?: boolean;
  onSettled?: () => void;
}) {
  return (
    <Loader
      variant="stacks"
      size="panel"
      framed={false}
      className="rounded-md bg-surface-sunken"
      label={label}
      progress={{ legs }}
      settled={settled}
      onSettled={onSettled}
    />
  );
}
