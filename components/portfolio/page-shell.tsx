import type { ReactNode } from "react";

import { NavLink, Wordmark } from "@/components/site-chrome";

export function PageShell({
  eyebrow,
  title,
  description,
  banner,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-page items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Wordmark />
          <nav aria-label="Primary" className="flex items-center gap-3 sm:gap-5">
            <NavLink href="/portfolio">Portfolio X-Ray</NavLink>
            <NavLink href="/studio">Thesis Studio</NavLink>
            <NavLink href="/demo">Demo</NavLink>
          </nav>
        </div>
      </header>
      {banner}
      <main className="mx-auto flex w-full max-w-page flex-1 flex-col gap-8 px-4 pt-8 pb-20 sm:px-6 sm:pt-10">
        <div className="flex flex-col gap-2">
          <p className="eyebrow text-muted-foreground">► {eyebrow}</p>
          <h1 className="font-display text-3xl font-semibold sm:text-4xl">{title}</h1>
          <p className="max-w-prose text-sm text-muted-foreground sm:text-base">{description}</p>
        </div>
        {children}
      </main>
      <footer className="border-t">
        <p className="mx-auto w-full max-w-page px-4 py-6 text-xs text-muted-foreground sm:px-6">
          Not investment advice. ThesisDeploy reads your accounts through SnapTrade and never trades without your
          confirmation.
        </p>
      </footer>
    </div>
  );
}

export function MessageCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="frame-marks flex max-w-xl flex-col gap-3 bg-card p-6 shadow-sm">
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <div className="flex flex-col gap-3 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
