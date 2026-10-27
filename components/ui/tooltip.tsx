"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import type { ReactElement, ReactNode } from "react"

/**
 * Hover and focus tooltip around one trigger element. Pair it with a
 * `focusableWhenDisabled` button so a disabled control can still explain why.
 */
function Tooltip({
  content,
  disabled,
  children,
}: {
  content: ReactNode
  disabled?: boolean
  children: ReactElement
}) {
  return (
    <TooltipPrimitive.Root disabled={disabled}>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="top" sideOffset={6}>
          <TooltipPrimitive.Popup className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground shadow-md transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0">
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip }
