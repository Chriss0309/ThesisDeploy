import { MessageCard } from "@/components/portfolio/page-shell";
import { ReauthRequiredError } from "@/lib/auth/vault";
import { SnapTradeError } from "@/lib/snaptrade/client";

export const LINK = "font-medium text-foreground underline underline-offset-4";

export function waitText(seconds: number | null | undefined) {
  return seconds ? `Try again in about ${Math.ceil(seconds)} seconds.` : "Try again in a minute.";
}

export function SnapTradeProblem({ error, returnTo }: { error: unknown; returnTo: string }) {
  if (error instanceof ReauthRequiredError) {
    return (
      <MessageCard title="Reconnect SnapTrade">
        <p>ThesisDeploy&apos;s access to SnapTrade expired or was revoked.</p>
        <p>
          <a href={`/api/auth/login?returnTo=${returnTo}`} className={LINK}>
            Sign in with SnapTrade again
          </a>{" "}
          to continue.
        </p>
      </MessageCard>
    );
  }
  if (error instanceof SnapTradeError && (error.code === "rate_limited" || error.code === "budget_exhausted")) {
    return (
      <MessageCard title="SnapTrade rate limit reached">
        <p>{waitText(error.retryAfterSeconds)}</p>
      </MessageCard>
    );
  }
  return (
    <MessageCard title="Couldn't load your accounts">
      <p>SnapTrade didn&apos;t respond as expected. Try again shortly.</p>
    </MessageCard>
  );
}
