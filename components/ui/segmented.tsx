"use client"

import { cn } from "cn"

export type SegmentedOption<T extends string> = { value: T; label: string; disabled?: boolean }

/**
 * Two or more outline buttons in one rounded group; the selected one is
 * ink-filled. Arrow keys move between enabled options, like a radio group.
 */
function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  className,
}: {
  name: string
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  className?: string
}) {
  const enabled = options.filter((option) => !option.disabled)
  const move = (delta: number) => {
    const index = enabled.findIndex((option) => option.value === value)
    const next = enabled[(index + delta + enabled.length) % enabled.length]
    if (next) onChange(next.value)
  }
  return (
    <div
      role="radiogroup"
      aria-label={name}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") move(1)
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(-1)
        else return
        event.preventDefault()
      }}
      className={cn(
        "grid auto-cols-fr grid-flow-col divide-x divide-input overflow-hidden rounded-md border border-input",
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-disabled={option.disabled || undefined}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => !option.disabled && onChange(option.value)}
          className={cn(
            "h-9 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset",
            value === option.value ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary",
            option.disabled && "cursor-not-allowed text-muted-foreground hover:bg-card"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export { Segmented }
