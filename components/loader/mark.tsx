import { classes as cn } from "./classes";
import { MARKS, type MarkKind } from "./timing";

const SIZES = {
  /** Beside a page title. */
  header: "h-(--mark-header-h-sm) w-(--mark-header-w-sm) sm:h-(--mark-header-h) sm:w-(--mark-header-w)",
  /** Beside a message, empty state, or error card. */
  card: "h-(--mark-card-h) w-(--mark-card-w)",
  /** Beside one line of text. */
  inline: "h-(--mark-inline-h) w-(--mark-inline-w)",
};

/**
 * A content-time motif: plays its pose once when it renders, then holds a still frame.
 * Decorative (the text beside it carries the meaning). Works in server components.
 */
export function Mark({
  kind,
  size = "card",
  reveal = "now",
  legs,
  className,
}: {
  kind: MarkKind;
  size?: keyof typeof SIZES;
  /** "data" waits for the page's <Reveal /> (its content) before playing. */
  reveal?: "now" | "data";
  /** Shares per leg for the basket stacks. */
  legs?: number[];
  className?: string;
}) {
  const { variant, pose } = MARKS[kind];
  return (
    <td-motif
      variant={variant}
      pose={pose}
      mode="mark"
      reveal={reveal === "data" ? "data" : undefined}
      legs={legs?.length ? legs.join(",") : undefined}
      aria-hidden="true"
      className={cn("group/mark block shrink-0 text-foreground", SIZES[size], className)}
    >
      <canvas className="size-full opacity-0 transition-opacity duration-(--duration-slow) ease-enter group-data-ready/mark:opacity-100" />
    </td-motif>
  );
}

/** Render with a page's content: the page's header mark plays its reveal when this lands. */
export function Reveal({ legs }: { legs?: number[] }) {
  return <td-reveal hidden legs={legs?.length ? legs.join(",") : undefined} />;
}
