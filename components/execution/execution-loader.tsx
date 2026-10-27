import { LoaderCircle } from "lucide-react";

/**
 * Every loading and in-progress visual for pre-flight and execution renders
 * through this component, so it can be replaced in one place.
 */
export function ExecutionLoader({ variant, label }: { variant: "preflight" | "execution"; label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      {variant === "execution" ? (
        <span aria-hidden className="size-2 animate-pace rounded-full bg-brand" />
      ) : (
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
      )}
      {label}
    </span>
  );
}
