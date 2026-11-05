"use client";

import { useLinkStatus } from "next/link";
import {
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { classes as cn } from "./classes";
import { Loader } from "./loader";
import type { LoaderVariant } from "./timing";

// A page that's being navigated away from (sign-in redirect, form submission) shows a
// fixed toast, so nothing in the layout moves. A real navigation unloads the page; the
// timeout and pageshow reset cover back-forward cache restores and stalled requests.
const STALE_MS = 30_000;

function usePending() {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const reset = () => setPending(false);
    const timer = window.setTimeout(reset, STALE_MS);
    window.addEventListener("pageshow", reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pageshow", reset);
    };
  }, [pending]);
  return [pending, setPending] as const;
}

/** Rendered only after an interaction, so it never runs during server rendering. */
export function NavigationStatus({ variant, label }: { variant: LoaderVariant; label: string }) {
  return createPortal(
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6">
      <div className="rounded-md bg-card px-4 py-3 text-card-foreground shadow-md ring-1 ring-border">
        <Loader variant={variant} size="inline" label={label} />
      </div>
    </div>,
    document.body,
  );
}

const plainClick = (event: MouseEvent<HTMLAnchorElement>) =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  event.currentTarget.target !== "_blank";

/** A plain anchor (full-page navigation) that shows a loader toast once clicked. */
export function PendingLink({
  pendingLabel,
  variant = "link",
  className,
  onClick,
  children,
  ...anchor
}: AnchorHTMLAttributes<HTMLAnchorElement> & { pendingLabel: string; variant?: LoaderVariant }) {
  const [pending, setPending] = usePending();
  return (
    <>
      <a
        {...anchor}
        aria-busy={pending || undefined}
        data-pending={pending || undefined}
        className={cn(className, "data-pending:opacity-70")}
        onClick={(event) => {
          onClick?.(event);
          if (plainClick(event)) setPending(true);
        }}
      >
        {children}
      </a>
      {pending && <NavigationStatus variant={variant} label={pendingLabel} />}
    </>
  );
}

/** A form that submits through `run`, then does a full load of the location it answers, as a redirect would. */
export function PendingForm({
  run,
  describeFailure,
  pendingLabel,
  variant = "link",
  children,
}: {
  run: () => Promise<{ location: string }>;
  describeFailure: (caught: unknown) => string;
  pendingLabel: string;
  variant?: LoaderVariant;
  children: ReactNode;
}) {
  const [pending, setPending] = usePending();
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <form
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
      className="group/pending"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setFailure(null);
        try {
          const { location } = await run();
          window.location.assign(location);
        } catch (caught) {
          setPending(false);
          setFailure(describeFailure(caught));
        }
      }}
    >
      {children}
      {failure && (
        <p role="alert" className="mt-1.5 text-xs text-negative-subtle-foreground">
          {failure}
        </p>
      )}
      {pending && <NavigationStatus variant={variant} label={pendingLabel} />}
    </form>
  );
}

/** Place inside a next/link <Link>: a toast while that navigation is pending. */
export function LinkPendingStatus({ variant, label }: { variant: LoaderVariant; label: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span hidden data-link-pending={pending || undefined} />
      {pending && <NavigationStatus variant={variant} label={label} />}
    </>
  );
}
