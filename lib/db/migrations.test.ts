import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { appTables } from "@/lib/db/schema";

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

describe("supabase/migrations", () => {
  it("apply cleanly and enable RLS on every app table", async () => {
    const pg = new PGlite();
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }

    const { rows } = await pg.query<{ name: string; rls: boolean }>(`
      select c.relname as name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `);

    expect(rows.map((row) => row.name)).toEqual(
      appTables.map((table) => getTableName(table)).sort(),
    );
    expect(rows.filter((row) => !row.rls)).toEqual([]);
    await pg.close();
  });
});
