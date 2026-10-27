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
  /** Omit when the legs aren't known yet (an action pre-flight): the stacks loop indeterminately. */
  legs?: ExecutionLeg[];
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
      progress={legs && { legs }}
      settled={settled}
      onSettled={onSettled}
    />
  );
}
