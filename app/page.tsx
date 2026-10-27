import { Suspense } from "react";

import { AuthPanel, AuthPanelSkeleton } from "@/components/auth-panel";
import { BackendStatus } from "@/components/backend-status";
import { CoinStage } from "@/components/landing/coin-stage";
import { LandingHeadline } from "@/components/landing/headline";
import { Wordmark } from "@/components/site-chrome";
import { TelemetryToggle } from "@/components/telemetry/telemetry-drawer";
import { ThesisPreview } from "@/components/thesis-preview";

const STEPS = [
  {
    title: "Portfolio X-Ray",
    body: "Sign in with SnapTrade to see cash by currency, positions, and concentration across your connected brokerage accounts.",
  },
  {
    title: "Thesis Studio",
    body: "Describe a theme. ThesisDeploy proposes candidates, SnapTrade grounds every ticker and quote, overlap with what you already hold is trimmed, and a solver sizes whole shares.",
  },
  {
    title: "Paced execution and drift",
    body: "Review a pre-flight, then orders go out one per second per account, live or as a paper simulation. Rebalance later, only when you confirm.",
  },
];

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-page items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Wordmark />
        <BackendStatus />
      </header>

      <main className="flex flex-1 flex-col gap-3 px-2 pb-16 sm:gap-4 sm:px-4">
        <section className="chamfer mx-auto w-full max-w-page bg-surface-tint [--chamfer:var(--chamfer-lg)]">
          <div className="flex flex-col gap-6 px-4 pt-10 pb-8 sm:px-8 sm:pt-14 lg:gap-8 lg:px-12 lg:pt-16 lg:pb-12">
            <div className="flex flex-col items-center text-center">
              <LandingHeadline />
            </div>
            <div className="grid items-center gap-6 lg:grid-cols-(--grid-hero) lg:gap-12">
              <CoinStage />
              <div className="flex flex-col gap-5">
                <p className="max-w-prose text-base text-pretty text-muted-foreground sm:text-lg">
                  ThesisDeploy turns a one-line conviction into a whole-share stock basket, checked against what you
                  already own, and places the orders in your own brokerage account, live or as a paper simulation.
                </p>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <a
                    href="/demo/studio"
                    className="eyebrow w-fit rounded-sm text-foreground underline decoration-brand decoration-2 underline-offset-6 outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    ► Try the Thesis Studio demo
                  </a>
                  <a
                    href="/demo"
                    className="eyebrow w-fit rounded-sm text-foreground underline decoration-brand decoration-2 underline-offset-6 outline-none hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    ► Explore the demo portfolio
                  </a>
                </div>
                <p className="text-xs text-muted-foreground">No sign-in needed for either demo.</p>
                <ThesisPreview
                  footer={
                    <Suspense fallback={<AuthPanelSkeleton />}>
                      <AuthPanel searchParams={searchParams} />
                    </Suspense>
                  }
                />
              </div>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="how-it-works"
          className="dark chamfer mx-auto w-full max-w-page [--chamfer:var(--chamfer-lg)]"
        >
          <div className="flex flex-col gap-8 px-4 py-10 sm:px-8 lg:px-12 lg:py-14">
            <div className="flex flex-col gap-3">
              <h2 id="how-it-works" className="eyebrow text-muted-foreground">
                How it works
              </h2>
              <p className="max-w-2xl font-display text-2xl font-semibold text-balance sm:text-3xl">
                From conviction to whole-share orders,{" "}
                <span className="text-highlight">checked against what you already own.</span>
              </p>
            </div>
            <ol className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-(--grid-steps)">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex flex-col gap-3 bg-background p-5 sm:p-6">
                  <span className="font-mono text-xs text-highlight">0{index + 1}</span>
                  <h3 className="font-display text-xl font-semibold">{step.title}</h3>
                  <p className="text-sm text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-page flex-col gap-3 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>Not investment advice. Paper mode never sends orders to a brokerage.</p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <TelemetryToggle />
            <a
              href="https://github.com/Chriss0309/ThesisDeploy"
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              Source on GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
