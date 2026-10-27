"use client"

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"

const Drawer = DialogPrimitive.Root
const DrawerTrigger = DialogPrimitive.Trigger
const DrawerClose = DialogPrimitive.Close
const DrawerTitle = DialogPrimitive.Title
const DrawerDescription = DialogPrimitive.Description

/**
 * Drawer per the design spec: a modal panel that slides in from the right
 * from `sm` (28rem, full height) and up from the bottom below it (90 vh,
 * `rounded-t-xl`), over the `overlay` scrim. Base UI traps focus, closes on
 * Esc, and returns focus to the trigger.
 */
function DrawerContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 bg-overlay transition-opacity duration-(--duration-slow) ease-enter data-ending-style:opacity-0 data-ending-style:ease-exit data-starting-style:opacity-0" />
      <DialogPrimitive.Viewport className="fixed inset-0 flex items-end sm:items-stretch sm:justify-end">
        <DialogPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            "flex max-h-(--sheet-max-height) w-full flex-col overflow-hidden rounded-t-xl bg-card text-card-foreground shadow-lg outline-none transition-transform duration-(--duration-slow) ease-enter data-ending-style:translate-y-full data-ending-style:ease-exit data-starting-style:translate-y-full sm:max-h-none sm:max-w-drawer sm:rounded-none sm:border-l sm:data-ending-style:translate-x-full sm:data-ending-style:translate-y-0 sm:data-starting-style:translate-x-full sm:data-starting-style:translate-y-0",
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

export { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger }
