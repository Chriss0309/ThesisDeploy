import Link from "next/link";

import { Mark, Reveal } from "@/components/loader/mark";
import { ThesisCard } from "@/components/theses/thesis-card";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ThesisCard as ThesisCardData } from "@/lib/theses/types";
import { cn } from "@/lib/utils";

/** The My Theses dashboard: open baskets first, then closed ones. */
export function ThesesView({ cards, demo }: { cards: ThesisCardData[]; demo: boolean }) {
  if (cards.length === 0) {
    return (
      <Card>
        <Reveal />
        <CardContent className="flex flex-col items-start gap-5 sm:flex-row">
          <Mark kind="empty" />
          <div className="flex flex-col items-start gap-3">
            <p className="eyebrow text-muted-foreground">► No theses yet</p>
            <p className="max-w-prose text-pretty">
              A thesis shows up here once you confirm a paper run from Thesis Studio. Then you can watch its value
              against what you paid, see how far each stock has drifted from its target, and rebalance or close it.
            </p>
            <Link href={demo ? "/demo/studio" : "/studio"} className={cn(buttonVariants())}>
              Build a basket
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }
  const open = cards.filter((card) => card.status !== "closed");
  const closed = cards.filter((card) => card.status === "closed");
  return (
    <div className="flex flex-col gap-6">
      <Reveal />
      {open.map((card) => (
        <ThesisCard key={card.id} card={card} demo={demo} />
      ))}
      {closed.length > 0 && (
        <section aria-label="Closed theses" className="flex flex-col gap-4">
          <p className="eyebrow text-muted-foreground">► Closed</p>
          {closed.map((card) => (
            <ThesisCard key={card.id} card={card} demo={demo} />
          ))}
        </section>
      )}
    </div>
  );
}
