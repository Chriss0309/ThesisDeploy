import { Loader } from "@/components/loader/loader";
import { DemoBanner } from "@/components/portfolio/demo-banner";
import { PageShell } from "@/components/portfolio/page-shell";
import { XRaySkeleton } from "@/components/portfolio/xray-view";

// Page headers shared by each page and its loading.tsx, so a route-level loading state
// hands over to the page's own Suspense fallback without anything moving.
export const SCREENS = {
  xray: {
    eyebrow: "01 · Read from SnapTrade",
    title: "Portfolio X-Ray",
    description: "Cash, buying power, positions, and concentration for each connected account.",
  },
  xrayDemo: {
    eyebrow: "01 · Guest demo",
    title: "Portfolio X-Ray",
    description: "Cash, buying power, positions, and concentration for each connected account.",
  },
  studio: {
    eyebrow: "02 · Build the basket",
    title: "Thesis Studio",
    description: "Turn a one-line conviction into a whole-share basket, checked against what you already hold.",
  },
  studioDemo: {
    eyebrow: "02 · Guest demo",
    title: "Thesis Studio",
    description: "Turn a one-line conviction into a whole-share basket, checked against what the portfolio already holds.",
  },
  basket: {
    eyebrow: "03 · Saved basket",
    title: "Virtual basket",
    description: "The orders you confirmed, the fills they produced, and the execution that placed them.",
  },
  basketDemo: {
    eyebrow: "03 · Guest demo",
    title: "Virtual basket",
    description: "The orders you confirmed, the fills they produced, and the execution that placed them.",
  },
  theses: {
    eyebrow: "04 · Valued live",
    title: "My Theses",
    description:
      "Every basket you've run, valued at current prices against what you paid, with drift from each target and a one-click rebalance.",
  },
  thesesDemo: {
    eyebrow: "04 · Guest demo",
    title: "My Theses",
    description:
      "Your saved demo baskets, valued at fictional quotes against what you paid, with drift from each target and a one-click rebalance.",
  },
} as const;

export const DEMO_XRAY_LOADING = { label: "Loading the demo portfolio…", detail: "Fictional accounts; no SnapTrade calls." };

export function StudioSkeleton({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex flex-col items-start gap-6 lg:flex-row">
      <div aria-hidden className="h-(--loader-panel) w-full rounded-lg bg-muted lg:w-96 lg:shrink-0" />
      <Loader variant="scan" label={label} detail={detail} className="w-full flex-1" />
    </div>
  );
}

export const STUDIO_LOADING = {
  label: "Loading your accounts and holdings…",
  detail: "The Studio reads every connected account so it can flag what you already own.",
};
export const DEMO_STUDIO_LOADING = { label: "Loading the demo portfolio…", detail: "Fictional accounts; no SnapTrade calls." };

export function XRayLoadingScreen({ demo = false }: { demo?: boolean }) {
  return (
    <PageShell
      {...(demo ? SCREENS.xrayDemo : SCREENS.xray)}
      banner={demo ? <DemoBanner active="xray" returnTo="/portfolio" /> : undefined}
    >
      <XRaySkeleton {...(demo ? DEMO_XRAY_LOADING : {})} />
    </PageShell>
  );
}

export function StudioLoadingScreen({ demo = false }: { demo?: boolean }) {
  return (
    <PageShell
      {...(demo ? SCREENS.studioDemo : SCREENS.studio)}
      banner={demo ? <DemoBanner active="studio" returnTo="/studio" /> : undefined}
    >
      <StudioSkeleton {...(demo ? DEMO_STUDIO_LOADING : STUDIO_LOADING)} />
    </PageShell>
  );
}

export function BasketSkeleton() {
  return <Loader variant="stacks" label="Loading the saved basket…" className="w-full" />;
}

export function BasketLoadingScreen({ demo = false }: { demo?: boolean }) {
  return (
    <PageShell
      {...(demo ? SCREENS.basketDemo : SCREENS.basket)}
      banner={demo ? <DemoBanner active="studio" returnTo="/studio" /> : undefined}
    >
      <BasketSkeleton />
    </PageShell>
  );
}

export function ThesesSkeleton({ demo = false }: { demo?: boolean }) {
  return (
    <Loader
      variant="scan"
      label={demo ? "Valuing your demo baskets…" : "Valuing your baskets at current prices…"}
      detail={demo ? "Fictional quotes; no SnapTrade calls." : "One quotes call per account, then drift from each target."}
      className="w-full"
    />
  );
}

export function ThesesLoadingScreen({ demo = false }: { demo?: boolean }) {
  return (
    <PageShell
      {...(demo ? SCREENS.thesesDemo : SCREENS.theses)}
      banner={demo ? <DemoBanner active="theses" returnTo="/theses" /> : undefined}
    >
      <ThesesSkeleton demo={demo} />
    </PageShell>
  );
}
