"use client"

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import type * as React from "react"

const Dialog = DialogPrimitive.Root
const DialogClose = DialogPrimitive.Close

/**
 * Modal per the design spec: `overlay` scrim, card fill, `rounded-xl`,
 * `shadow-lg`, 40rem wide with 24 px padding. Below `sm` it becomes a bottom
 * sheet (90 vh, `rounded-t-xl`). Base UI traps focus, closes on Esc, and
 * returns focus to the trigger.
 */
function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 bg-overlay transition-opacity duration-(--duration-slow) ease-enter data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <DialogPrimitive.Viewport className="fixed inset-0 flex items-end justify-center sm:items-center sm:p-6">
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cn(
            "flex max-h-(--sheet-max-height) w-full max-w-modal flex-col overflow-y-auto rounded-t-xl bg-card text-card-foreground shadow-lg outline-none transition duration-(--duration-slow) ease-enter data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 data-starting-style:opacity-0 sm:rounded-xl",
            className
          )}
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title className={cn("font-display text-2xl font-semibold", className)} {...props} />
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />
}

function DialogSection({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-6", className)} {...props} />
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogSection, DialogTitle }
