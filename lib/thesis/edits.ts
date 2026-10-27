import { z } from "zod";

import { getDb } from "@/lib/db/client";

/** One Basket Composer edit; feeds the basket edit rate. */
export const EditSchema = z.object({
  action: z.enum(["remove", "restore", "reweight", "step"]),
  symbol: z.string().min(1).max(24),
});

export const GuestEditSchema = EditSchema.extend({ ref: z.uuid() });

/** Guests may record edits only on a basket the demo served to their cookie in the last day. */
export async function servedToGuest(guestKey: string, ref: string): Promise<boolean> {
  const rows = await getDb().$queryRaw<{ ok: number }[]>`
    select 1 as ok from events
    where guest_key = ${guestKey} and created_at > now() - interval '1 day'
      and name = 'thesis_generated' and props->>'ref' = ${ref}
    limit 1`;
  return rows.length > 0;
}
