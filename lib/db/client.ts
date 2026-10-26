import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { serverEnv } from "@/lib/env";
import * as schema from "@/lib/db/schema";

function createDb(url: string) {
  const client = postgres(url, {
    // Supabase's transaction pooler (port 6543) does not support prepared statements.
    prepare: false,
    max: 5,
    connect_timeout: 5,
    idle_timeout: 20,
  });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

let cached: { url: string; db: Db } | undefined;

export function getDb(url?: string): Db {
  const databaseUrl = url ?? serverEnv().DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (cached?.url !== databaseUrl) cached = { url: databaseUrl, db: createDb(databaseUrl) };
  return cached.db;
}
