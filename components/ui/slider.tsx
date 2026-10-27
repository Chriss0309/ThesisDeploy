"use client"

import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "cn"

/**
 * Single-value slider: 4 px `chart-track`, `brand` fill, 18 px card-colored
 * thumb with an ink ring. Arrow keys move by `step`, Page Up/Down and
 * Shift+arrow by `largeStep`.
 */
function Slider({
  className,
  "aria-label": ariaLabel,
  ...props
}: SliderPrimitive.Root.Props<number> & { "aria-label": string }) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("w-full touch-none select-none data-disabled:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full items-center">
        <SliderPrimitive.Track className="relative h-1 w-full rounded-full bg-chart-track">
          <SliderPrimitive.Indicator className="rounded-full bg-brand" />
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            className="size-4.5 rounded-full border-(length:--slider-thumb-border) border-foreground bg-card shadow-sm transition-shadow outline-none has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
