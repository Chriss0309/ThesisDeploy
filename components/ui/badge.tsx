import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 font-mono text-2xs font-medium tracking-badge whitespace-nowrap uppercase",
  {
    variants: {
      tone: {
        neutral: "border-border-strong bg-card text-muted-foreground",
        positive: "border-positive-border bg-positive-subtle text-positive-subtle-foreground",
        warning: "border-warning-border bg-warning-subtle text-warning-subtle-foreground",
        negative: "border-negative-border bg-negative-subtle text-negative-subtle-foreground",
        info: "border-info-border bg-info-subtle text-info-subtle-foreground",
        solid: "border-primary bg-primary text-primary-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

const DOT: Record<NonNullable<VariantProps<typeof badgeVariants>["tone"]>, string> = {
  neutral: "bg-muted-foreground",
  positive: "bg-positive",
  warning: "bg-warning",
  negative: "bg-negative",
  info: "bg-info",
  solid: "bg-positive animate-pace",
}

function Badge({
  className,
  tone = "neutral",
  dot = false,
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", DOT[tone ?? "neutral"])} />}
      {children}
    </span>
  )
}

export { Badge, badgeVariants }
