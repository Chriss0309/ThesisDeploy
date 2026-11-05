import { z } from "zod";

import { getAuthConfig, isAuthConfigured } from "@/lib/auth/config";
import { signOut } from "@/lib/auth/flow";
import type { AuthNotice } from "@/lib/auth/http";
import { SESSION_COOKIE } from "@/lib/auth/sessions";
import { getGrantSummary } from "@/lib/auth/vault";
import { publicProcedure, router } from "@/server/trpc";

export const authRouter = router({
  userId: publicProcedure.query(({ ctx }) => ctx.user?.id ?? null),

  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.user) return { user: null, snaptrade: null };
    const { name, email, emailVerified, id } = ctx.user;
    const grant = await getGrantSummary(id);
    return {
      user: { name, email, emailVerified },
      snaptrade: grant && {
        scopes: grant.scopes,
        canTrade: grant.scopes.includes("trade"),
        accessExpiresAt: grant.accessExpiresAt.toISOString(),
      },
    };
  }),

  logout: publicProcedure.input(z.object({ disconnect: z.boolean() })).mutation(async ({ ctx, input }) => {
    let notice: AuthNotice = "signed_out";
    if (ctx.sessionToken && isAuthConfigured()) {
      const { revoked } = await signOut(getAuthConfig(), ctx.sessionToken, { disconnect: input.disconnect });
      if (input.disconnect) notice = revoked ? "disconnected" : "disconnect_partial";
    }
    ctx.resHeaders.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    return { location: `/?auth=${notice}` };
  }),
});
