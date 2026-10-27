"use client";

import { useEffect } from "react";

import { Mark } from "@/components/loader/mark";

// Every route's initial JS carries this boundary, so it stays plain markup: no page
// shell, no button variants (their class merging would ship to every page).
const ACTION =
  "inline-flex h-9 items-center justify-center rounded-md border px-3.5 text-sm font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error && "digest" in error ? String(error.digest) : null;
  return (
    <main className="mx-auto flex min-h-(--page-main-min) w-full max-w-page flex-1 flex-col justify-center px-4 py-16 sm:px-6">
      <div className="frame-marks mx-auto flex max-w-xl flex-col items-start gap-4 bg-card p-6 shadow-sm sm:flex-row sm:gap-5">
        <Mark kind="error" />
        <div className="flex flex-col gap-3">
          <p className="eyebrow text-muted-foreground">► Error</p>
          <h1 className="font-display text-2xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            This page hit an unexpected error. Nothing was ordered or changed; try again, or head back to the start.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => retry()}
              className={`${ACTION} border-transparent bg-primary text-primary-foreground hover:bg-primary-hover`}
            >
              Try again
            </button>
            {/* A full page load resets whatever broke, and keeps next/link out of every page's initial JS. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className={`${ACTION} border-input bg-card text-foreground hover:bg-secondary`}>
              Back to ThesisDeploy
            </a>
          </div>
          {digest && (
            <p className="text-xs text-muted-foreground">
              Reference <span className="font-mono">{digest}</span>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
