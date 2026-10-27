import type { Metadata } from "next";
import { Suspense } from "react";

import { PageShell } from "@/components/portfolio/page-shell";
import { XRaySkeleton, XRayView } from "@/components/portfolio/xray-view";
import { demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";

export const metadata: Metadata = {
  title: "Demo portfolio · ThesisDeploy",
  description: "Portfolio X-Ray on fictional fixture data, no sign-in required.",
};

async function DemoXRay({ searchParams }: { searchParams: PageProps<"/demo">["searchParams"] }) {
  const { account } = await searchParams;
  const overview = demoOverview();
  const selected =
    overview.accounts.find((candidate) => candidate.id === account) ?? overview.accounts[0];
  const snapshot = demoSnapshot(selected.id);
  return (
    <XRayView
      mode="demo"
      overview={overview}
      selected={selected}
      result={snapshot && { snapshot, source: "cache" }}
      basePath="/demo"
    />
  );
}

export default function DemoPage({ searchParams }: PageProps<"/demo">) {
  return (
    <PageShell
      eyebrow="01 · Guest demo"
      title="Portfolio X-Ray"
      description="Cash, buying power, positions, and concentration for each connected account."
      banner={
        <div className="border-b border-info-border bg-info-subtle px-4 py-2.5 text-center text-xs text-info-subtle-foreground sm:px-6">
          <span className="eyebrow mr-2">Demo</span>
          Fictional data: no brokerage, no SnapTrade account, no sign-in.{" "}
          <a
            href="/api/auth/login?returnTo=/portfolio"
            className="font-medium underline underline-offset-4 hover:text-foreground"
          >
            Sign in with SnapTrade
          </a>{" "}
          to see your own accounts.
        </div>
      }
    >
      <Suspense fallback={<XRaySkeleton />}>
        <DemoXRay searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
