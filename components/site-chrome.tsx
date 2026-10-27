"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { LinkPendingStatus } from "@/components/loader/pending";

export function Wordmark() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 rounded-sm font-display text-lg font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <span
        aria-hidden
        className="chamfer grid size-6 place-items-center bg-primary font-mono text-2xs font-medium text-primary-foreground [--chamfer:var(--chamfer-sm)]"
      >
        TD
      </span>
      ThesisDeploy
    </Link>
  );
}

const NAV_LINK =
  "eyebrow rounded-sm px-1 py-1 text-muted-foreground underline-offset-6 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 aria-[current=page]:text-foreground aria-[current=page]:underline aria-[current=page]:decoration-brand aria-[current=page]:decoration-2";

type NavLinkProps = { href: string; children: ReactNode; pendingLabel?: string };

export function NavLink({ href, children, pendingLabel }: NavLinkProps) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={NAV_LINK}>
      {children}
      {pendingLabel && <LinkPendingStatus variant="scan" label={pendingLabel} />}
    </Link>
  );
}

/** The same link without the active state, for prerendering routes whose path is only known at request time. */
export function NavLinkFallback({ href, children, pendingLabel }: NavLinkProps) {
  return (
    <Link href={href} className={NAV_LINK}>
      {children}
      {pendingLabel && <LinkPendingStatus variant="scan" label={pendingLabel} />}
    </Link>
  );
}
