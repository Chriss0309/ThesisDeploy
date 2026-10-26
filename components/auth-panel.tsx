import { Button, buttonVariants } from "@/components/ui/button";
import { isAuthConfigured } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getGrantSummary } from "@/lib/auth/vault";
import { describeError } from "@/lib/errors";
import { cn } from "@/lib/utils";

const NOTICES: Record<string, { error: boolean; text: string }> = {
  signed_out: { error: false, text: "You're signed out." },
  disconnected: {
    error: false,
    text: "SnapTrade is disconnected. ThesisDeploy revoked its access and deleted its tokens.",
  },
  disconnect_partial: {
    error: true,
    text: "ThesisDeploy deleted its tokens, but SnapTrade didn't confirm the revocation. You can also remove access in the SnapTrade Dashboard.",
  },
  not_configured: { error: true, text: "Sign-in isn't configured on this deployment yet." },
  access_denied: { error: true, text: "You declined access in SnapTrade, so you're not signed in." },
  state_mismatch: {
    error: true,
    text: "That sign-in attempt expired or was started in another browser. Please try again.",
  },
  signin_failed: { error: true, text: "Signing in with SnapTrade failed. Please try again." },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function loadSession() {
  try {
    const user = await getCurrentUser();
    return { user, grant: user ? await getGrantSummary(user.id) : null, unavailable: false };
  } catch (error) {
    console.error("[auth] session lookup failed", describeError(error));
    return { user: null, grant: null, unavailable: true };
  }
}

export async function AuthPanel({ searchParams }: { searchParams: SearchParams }) {
  const { auth } = await searchParams;
  const notice = typeof auth === "string" ? NOTICES[auth] : undefined;
  const configured = isAuthConfigured();
  const { user, grant, unavailable } = configured
    ? await loadSession()
    : { user: null, grant: null, unavailable: false };

  return (
    <div className="flex w-full flex-col gap-3">
      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={cn(
            "rounded-md border px-3 py-2 text-xs",
            notice.error ? "border-destructive/30 text-destructive" : "text-muted-foreground",
          )}
        >
          {notice.text}
        </p>
      )}

      {user ? (
        <>
          <div className="flex flex-col gap-1 text-sm">
            <span>
              Signed in as <strong>{user.name ?? user.email ?? "SnapTrade user"}</strong>
            </span>
            <span className="text-xs text-muted-foreground">
              {!grant
                ? "SnapTrade access expired or was revoked. Reconnect to continue."
                : grant.scopes.includes("trade")
                  ? "Read and trade access granted. Orders are only placed after you confirm them."
                  : "Read-only access. Sign in again and approve trading to place orders."}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {grant ? (
              <a href="/portfolio" className={buttonVariants({ size: "sm" })}>
                Open Portfolio X-Ray
              </a>
            ) : (
              <a href="/api/auth/login" className={buttonVariants({ size: "sm" })}>
                Reconnect SnapTrade
              </a>
            )}
            <form action="/api/auth/logout" method="post">
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
            <form action="/api/auth/logout?disconnect=1" method="post">
              <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                Disconnect SnapTrade
              </Button>
            </form>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
          {configured && !unavailable ? (
            <a href="/api/auth/login" className={buttonVariants({ size: "lg" })}>
              Sign in with SnapTrade
            </a>
          ) : (
            <Button size="lg" disabled>
              Sign in with SnapTrade
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            {!configured
              ? "Sign-in isn't configured on this deployment yet."
              : unavailable
                ? "Sign-in is temporarily unavailable."
                : "You'll review read and trade permissions in SnapTrade. Nothing is traded without your confirmation."}
          </p>
        </div>
      )}
    </div>
  );
}

export function AuthPanelSkeleton() {
  return <div className="h-9 w-full animate-pulse rounded-md bg-muted" aria-hidden />;
}
