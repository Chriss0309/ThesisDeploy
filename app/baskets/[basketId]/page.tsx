import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { BasketRecord } from "@/components/execution/basket-record";
import { PendingLink } from "@/components/loader/pending";
import { MessageCard, PageShell } from "@/components/portfolio/page-shell";
import { LINK } from "@/components/portfolio/snaptrade-problem";
import { BasketSkeleton, SCREENS } from "@/components/screens";
import { isAuthConfigured } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { findBasketView } from "@/lib/execution/store";

export const metadata: Metadata = { title: "Virtual basket · ThesisDeploy" };

// A page already opened in this tab stays up for 10 minutes, so switching back doesn't flash the skeleton.
export const unstable_dynamicStaleTime = 600;

async function SignedInBasket({ params }: { params: PageProps<"/baskets/[basketId]">["params"] }) {
  const { basketId } = await params;
  const user = isAuthConfigured() ? await getCurrentUser() : null;
  if (!user) {
    return (
      <MessageCard title="Sign in to see this basket" mark="signin">
        <p>
          <PendingLink
            href={`/api/auth/login?returnTo=/baskets/${encodeURIComponent(basketId)}`}
            className={LINK}
            pendingLabel="Opening SnapTrade…"
          >
            Sign in with SnapTrade
          </PendingLink>{" "}
          to open your saved baskets.
        </p>
      </MessageCard>
    );
  }
  if (!z.uuid().safeParse(basketId).success) notFound();
  const basket = await findBasketView(basketId, { userId: user.id, guestKey: null });
  if (!basket) notFound();
  return <BasketRecord basket={basket} studioPath="/studio" thesesPath="/theses" />;
}

export default function BasketPage({ params }: PageProps<"/baskets/[basketId]">) {
  return (
    <PageShell {...SCREENS.basket}>
      <Suspense fallback={<BasketSkeleton />}>
        <SignedInBasket params={params} />
      </Suspense>
    </PageShell>
  );
}
