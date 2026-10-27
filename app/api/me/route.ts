import { getCurrentUser } from "@/lib/auth/current-user";
import { noStore } from "@/lib/auth/http";
import { getGrantSummary } from "@/lib/auth/vault";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return noStore(Response.json({ user: null }, { status: 401 }));

  const grant = await getGrantSummary(user.id);
  return noStore(
    Response.json({
      user: { name: user.name, email: user.email, emailVerified: user.emailVerified },
      snaptrade: grant && {
        scopes: grant.scopes,
        canTrade: grant.scopes.includes("trade"),
        accessExpiresAt: grant.accessExpiresAt.toISOString(),
      },
    }),
  );
}
