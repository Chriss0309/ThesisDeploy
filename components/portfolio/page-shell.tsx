import Link from "next/link";
import type { ReactNode } from "react";

export function PageShell({
  title,
  description,
  banner,
  children,
}: {
  title: string;
  description: string;
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          ThesisDeploy
        </Link>
        <nav className="flex gap-4 text-sm text-muted-foreground">
          <Link href="/portfolio" className="hover:text-foreground">
            Portfolio X-Ray
          </Link>
          <Link href="/demo" className="hover:text-foreground">
            Demo
          </Link>
        </nav>
      </header>
      {banner}
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 pt-6 pb-20">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {children}
      </main>
      <footer className="mx-auto w-full max-w-6xl border-t px-6 py-6 text-xs text-muted-foreground">
        Not investment advice. ThesisDeploy reads your accounts through SnapTrade and never trades without your
        confirmation.
      </footer>
    </div>
  );
}

export function MessageCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-xl border p-6">
      <h2 className="font-medium">{title}</h2>
      <div className="flex flex-col gap-3 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
