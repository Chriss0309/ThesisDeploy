import { createHash } from "node:crypto";

import { hmacHex } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/client";
import { serverEnv } from "@/lib/env";

export const USER_GENERATIONS_PER_DAY = 30;
export const GUEST_GENERATIONS_PER_CLIENT_PER_DAY = 3;
const EVENT = "thesis_requested";

export type GenerationQuota =
  | { kind: "user"; userId: string }
  /** `client` is null for preset cache fills, which only count toward the global cap. */
  | { kind: "guest"; client: string | null; globalPerDay: number };

export type Reservation =
  | { ok: true }
  | { ok: false; scope: "user" | "client" | "global"; retryAfterSeconds: number };

type Counts = { mine: number; total: number; mine_reset: number | null; total_reset: number | null };

const seconds = (value: number | null) => Math.max(60, Math.ceil(value ?? 24 * 3600));

/**
 * Rolling 24-hour generation limits, counted from `events` so every
 * serverless instance shares them. The request is recorded first and then
 * counted along with everything else in the window, so concurrent requests
 * see each other: a race can undershoot the limit but never exceed it.
 * Rejected requests delete their row, so rejected spam doesn't use up the
 * global guest allowance.
 */
export async function reserveGeneration(quota: GenerationQuota): Promise<Reservation> {
  const db = getDb();
  const row = await db.event.create({
    data:
      quota.kind === "user"
        ? { name: EVENT, userId: quota.userId, props: { guest: false } }
        : { name: EVENT, props: { guest: true, client: quota.client } },
    select: { id: true },
  });

  const [counts] =
    quota.kind === "user"
      ? await db.$queryRaw<Counts[]>`
          select count(*)::int as mine, count(*)::int as total,
                 extract(epoch from min(created_at) + interval '24 hours' - now())::float8 as mine_reset,
                 null::float8 as total_reset
          from events
          where name = ${EVENT} and user_id = ${quota.userId}::uuid
            and created_at > now() - interval '24 hours'`
      : await db.$queryRaw<Counts[]>`
          select count(*) filter (where props->>'client' = ${quota.client})::int as mine,
                 count(*)::int as total,
                 extract(epoch from min(created_at) filter (where props->>'client' = ${quota.client})
                   + interval '24 hours' - now())::float8 as mine_reset,
                 extract(epoch from min(created_at) + interval '24 hours' - now())::float8 as total_reset
          from events
          where name = ${EVENT} and user_id is null
            and created_at > now() - interval '24 hours'`;

  let rejection: Reservation | null = null;
  if (quota.kind === "user") {
    if (counts.mine > USER_GENERATIONS_PER_DAY) {
      rejection = { ok: false, scope: "user", retryAfterSeconds: seconds(counts.mine_reset) };
    }
  } else if (quota.client && counts.mine > GUEST_GENERATIONS_PER_CLIENT_PER_DAY) {
    rejection = { ok: false, scope: "client", retryAfterSeconds: seconds(counts.mine_reset) };
  } else if (counts.total > quota.globalPerDay) {
    rejection = { ok: false, scope: "global", retryAfterSeconds: seconds(counts.total_reset) };
  }
  if (!rejection) return { ok: true };
  await db.event.delete({ where: { id: row.id } });
  return rejection;
}

/** A guest's IP, keyed with SESSION_SECRET when available; raw addresses are never stored. */
export function guestClientKey(ip: string): string {
  const secret = serverEnv().SESSION_SECRET;
  const value = `thesis-guest:${ip}`;
  const digest = secret
    ? hmacHex(Buffer.from(secret, "base64"), value)
    : createHash("sha256").update(value).digest("hex");
  return digest.slice(0, 32);
}
