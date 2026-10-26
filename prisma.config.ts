import { defineConfig } from "prisma/config";

// The CLI (migrations) uses the direct or session-pooler connection; the app
// uses DATABASE_URL (transaction pooler) through the driver adapter.
// process.env rather than env() so `prisma generate` works without a database.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DIRECT_URL ?? "",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
