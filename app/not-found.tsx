import type { Metadata } from "next";
import Link from "next/link";

import { Reveal } from "@/components/loader/mark";
import { PageShell } from "@/components/portfolio/page-shell";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Not found · ThesisDeploy" };

export default function NotFound() {
  return (
    <PageShell
      eyebrow="404 · Not found"
      title="Nothing at this address"
      description="The page or basket you asked for doesn't exist, or it belongs to another SnapTrade account."
      mark="lost"
    >
      <div className="flex flex-wrap gap-2">
        <Link href="/" className={buttonVariants()}>
          Back to ThesisDeploy
        </Link>
        <Link href="/theses" className={buttonVariants({ variant: "outline" })}>
          My Theses
        </Link>
      </div>
      <Reveal />
    </PageShell>
  );
}
