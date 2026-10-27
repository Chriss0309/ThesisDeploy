import type { Metadata } from "next";
import { Suspense } from "react";

import { DemoBanner } from "@/components/portfolio/demo-banner";
import { PageShell } from "@/components/portfolio/page-shell";
import { ThesisStudio } from "@/components/thesis/thesis-studio";
import { DEMO_STUDIO_LOADING, SCREENS, StudioSkeleton } from "@/components/screens";
import { configuredFeatures, serverEnv } from "@/lib/env";
import { demoOverview, demoSnapshot } from "@/lib/portfolio/fixtures";
import { GUEST_GENERATIONS_PER_CLIENT_PER_DAY } from "@/lib/thesis/rate-limit";
import { initialStudioAccount, toStudioAccount } from "@/lib/thesis/portfolio";

export const metadata: Metadata = {
  title: "Demo Thesis Studio · ThesisDeploy",
  description: "Turn a thesis into a whole-share basket on a fictional portfolio, no sign-in required.",
};

function generationNote() {
  const env = serverEnv();
  const live = configuredFeatures(env).anthropic && Boolean(env.DATABASE_URL) && env.GUEST_GENERATIONS_PER_DAY > 0;
  return live
    ? {
        presets: true,
        custom: true,
        note: `Presets are generated once per account, currency, and overlap setting, then served from cache. Custom prompts call Claude live: ${GUEST_GENERATIONS_PER_CLIENT_PER_DAY} per visitor per day.`,
      }
    : {
        presets: true,
        custom: false,
        note: "Live generation is off on this deployment, so presets show committed sample baskets and custom prompts are disabled. Prices and grounding still run.",
      };
}

async function DemoStudio({ searchParams }: { searchParams: PageProps<"/demo/studio">["searchParams"] }) {
  const { account, preset, prompt } = await searchParams;
  const accounts = demoOverview().accounts.map((candidate) =>
    toStudioAccount({ account: candidate, snapshot: demoSnapshot(candidate.id) }),
  );
  return (
    <ThesisStudio
      mode="demo"
      endpoint="/api/demo/theses"
      accounts={accounts}
      initialAccountId={initialStudioAccount(accounts, account).id}
      initialPresetKey={typeof preset === "string" ? preset : null}
      initialPrompt={typeof prompt === "string" ? prompt : null}
      generation={generationNote()}
    />
  );
}

export default function DemoStudioPage({ searchParams }: PageProps<"/demo/studio">) {
  return (
    <PageShell {...SCREENS.studioDemo} banner={<DemoBanner active="studio" returnTo="/studio" />}>
      <Suspense fallback={<StudioSkeleton {...DEMO_STUDIO_LOADING} />}>
        <DemoStudio searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
