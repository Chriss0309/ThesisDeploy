import { PrismaPg } from "@prisma/adapter-pg";

import { serverEnv } from "@/lib/env";
import { PrismaClient } from "@/lib/generated/prisma/client";

function createClient(url: string) {
  const adapter = new PrismaPg({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 20_000,
  });
  return new PrismaClient({ adapter });
}

// Kept on globalThis so Next.js dev reloads reuse one pool.
const globalForDb = globalThis as typeof globalThis & {
  thesisDeployDb?: { url: string; client: PrismaClient };
};

export function getDb(url?: string): PrismaClient {
  const databaseUrl = url ?? serverEnv().DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (globalForDb.thesisDeployDb?.url !== databaseUrl) {
    globalForDb.thesisDeployDb = { url: databaseUrl, client: createClient(databaseUrl) };
  }
  return globalForDb.thesisDeployDb.client;
}
