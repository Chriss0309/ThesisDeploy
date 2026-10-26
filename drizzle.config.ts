import { defineConfig } from "drizzle-kit";

// Migrations run over the direct (session) connection, not the transaction
// pooler the app uses at runtime.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./supabase/migrations",
  migrations: { prefix: "supabase" },
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
