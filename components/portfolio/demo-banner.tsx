import Link from "next/link";

import { cn } from "@/lib/utils";

const TABS = [
  { key: "xray", href: "/demo", label: "Portfolio X-Ray" },
  { key: "studio", href: "/demo/studio", label: "Thesis Studio" },
] as const;

export function DemoBanner({ active, returnTo }: { active: (typeof TABS)[number]["key"]; returnTo: string }) {
  return (
    <div className="border-y bg-sky-50 px-6 py-2 text-xs text-sky-900">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p>
          Guest demo on fictional data: no brokerage, no SnapTrade account, no sign-in.{" "}
          <a href={`/api/auth/login?returnTo=${returnTo}`} className="font-medium underline underline-offset-4">
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
              className={cn(
                "rounded-md px-2 py-1 font-medium",
                tab.key === active ? "bg-sky-900 text-white" : "hover:bg-sky-100",
              )}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
