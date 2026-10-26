import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { APP_TABLES } from "@/lib/db/check";

const MIGRATIONS_DIR = join(process.cwd(), "prisma/migrations");

describe("prisma/migrations", () => {
  it("apply cleanly, create exactly APP_TABLES, and enable RLS on each", async () => {
    const pg = new PGlite();
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    }

    const { rows } = await pg.query<{ name: string; rls: boolean }>(`
      select c.relname as name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `);

    expect(rows.map((row) => row.name)).toEqual([...APP_TABLES].sort());
    expect(rows.filter((row) => !row.rls)).toEqual([]);
    await pg.close();
  });
});
