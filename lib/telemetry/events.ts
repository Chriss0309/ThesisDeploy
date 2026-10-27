import { getDb } from "@/lib/db/client";
import { serverEnv } from "@/lib/env";
import { describeError } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";

/** Who an event belongs to: a signed-in user, or a guest demo cookie (its keyed hash). */
export type EventOwner = { userId?: string | null; guestKey?: string | null };

// Telemetry must never break the flow it observes, and is off without a database.
export async function recordEvent(
  name: string,
  props: Prisma.InputJsonObject = {},
  owner?: string | EventOwner,
): Promise<void> {
  const { userId, guestKey } = typeof owner === "string" ? { userId: owner, guestKey: null } : (owner ?? {});
  try {
    if (!serverEnv().DATABASE_URL) return;
    await getDb().event.create({ data: { name, props, userId: userId ?? null, guestKey: guestKey ?? null } });
  } catch (error) {
    console.error("[telemetry] event dropped", { name, ...describeError(error) });
  }
}
