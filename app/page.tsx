import { Suspense } from "react";

import { AuthPanel, AuthPanelSkeleton } from "@/components/auth-panel";
import { BackendStatus } from "@/components/backend-status";
import { ThesisPreview } from "@/components/thesis-preview";

const STEPS = [
  {
    title: "Portfolio X-Ray",
    body: "Sign in with SnapTrade to see cash by currency, positions, and concentration across your connected brokerage accounts.",
  },
  {
    title: "Thesis Studio",
    body: "Describe a theme. Claude proposes candidates, SnapTrade grounds every ticker and quote, overlap with what you already hold is trimmed, and a solver sizes whole shares.",
  },
  {
    title: "Paced execution and drift",
    body: "Review a pre-flight, then orders go out one per second per account, live or as a paper simulation. Rebalance later, only when you confirm.",
  },
];

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <span className="text-sm font-semibold tracking-tight">ThesisDeploy</span>
        <BackendStatus />
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-6 pt-10 pb-20 sm:pt-16">
        <section className="grid items-start gap-10 lg:grid-cols-[1.1fr_1fr]">
          <div className="flex flex-col gap-5">
            <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              Built on SnapTrade OAuth
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Invest in a thesis, not a ticker list.
            </h1>
            <p className="max-w-xl text-lg text-pretty text-muted-foreground">
              ThesisDeploy turns a one-line conviction into a whole-share stock
              basket, checked against what you already own, and places the
              orders in your own brokerage account, live or as a paper
              simulation.
            </p>
          </div>
          <ThesisPreview
            footer={
              <Suspense fallback={<AuthPanelSkeleton />}>
                <AuthPanel searchParams={searchParams} />
              </Suspense>
            }
          />
        </section>

        <section aria-labelledby="how-it-works" className="flex flex-col gap-6">
          <h2 id="how-it-works" className="text-sm font-medium text-muted-foreground">
            How it works
          </h2>
          <ol className="grid gap-6 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex flex-col gap-2 border-t pt-4">
                <span className="font-mono text-xs text-muted-foreground">
                  0{index + 1}
                </span>
                <h3 className="font-medium">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-5xl flex-col gap-2 border-t px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between">
        <p>Not investment advice. Paper mode never sends orders to a brokerage.</p>
        <a
          href="https://github.com/Chriss0309/ThesisDeploy"
          className="underline-offset-4 hover:underline"
        >
          Source on GitHub
        </a>
      </footer>
    </div>
  );
}
