import { getDb } from "@/lib/db/client";
import { describeError } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";

// Telemetry must never break the flow it observes.
export async function recordEvent(
  name: string,
  props: Prisma.InputJsonObject = {},
  userId?: string,
): Promise<void> {
  try {
    await getDb().event.create({ data: { name, props, userId } });
  } catch (error) {
    console.error("[telemetry] event dropped", { name, ...describeError(error) });
  }
}
