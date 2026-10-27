import Link from "next/link";

const TABS = [
  { key: "xray", href: "/demo", label: "Portfolio X-Ray" },
  { key: "studio", href: "/demo/studio", label: "Thesis Studio" },
  { key: "theses", href: "/demo/theses", label: "My Theses" },
] as const;

export function DemoBanner({ active, returnTo }: { active: (typeof TABS)[number]["key"]; returnTo: string }) {
  return (
    <div className="border-b border-info-border bg-info-subtle px-4 py-2.5 text-xs text-info-subtle-foreground sm:px-6">
      <div className="mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p>
          <span className="eyebrow mr-2">Demo</span>
          Fictional data: no brokerage, no SnapTrade account, no sign-in.{" "}
          <a
            href={`/api/auth/login?returnTo=${returnTo}`}
            className="font-medium underline underline-offset-4 hover:text-foreground"
          >
            Sign in with SnapTrade
          </a>{" "}
          to use your own accounts.
        </p>
        <nav aria-label="Demo screens" className="flex gap-1">
          {TABS.map((tab) => (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={tab.key === active ? "page" : undefined}
              className="eyebrow rounded-sm px-2 py-1 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 aria-[current=page]:bg-card aria-[current=page]:text-foreground aria-[current=page]:shadow-xs"
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
