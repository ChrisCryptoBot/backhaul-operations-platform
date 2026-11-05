import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * dispatch-desk/supabase is generated from prisma/migrations (apps/web/scripts/export-supabase.mjs, `npm run db:export-supabase`). Prisma stays the source of truth; this test fails until the
 * generator has been run again, so the hand-applied copy cannot drift from what the desk expects.
 */
const root = path.join(__dirname, "..", "..", "..");
const prismaDir = path.join(root, "prisma", "migrations");
const migDir = path.join(root, "supabase", "migrations");
const RETIRE = "20261028010000_retire_legacy_dispatch_tables";
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const deskFolders = fs
  .readdirSync(prismaDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name) && d.name.slice(0, 14) >= "20261028000000" && d.name !== RETIRE)
  .map((d) => d.name)
  .sort();
const mirrored = fs.readdirSync(migDir).sort();

describe("the Supabase migrations folder mirrors the desk's Prisma migrations", () => {
  it("has a file for every desk migration, plus the preflight first and the lockdown last", () => {
    expect(mirrored).toEqual(["20261027000000_extensions.sql", ...deskFolders.map((f) => `${f}.sql`), "20261129000000_enable_rls.sql"]);
  });

  it("names are 14-digit, unique and ascending, so the Supabase CLI accepts them in order", () => {
    const stamps = mirrored.map((f) => f.slice(0, 14));
    expect(stamps.every((s) => /^\d{14}$/.test(s))).toBe(true);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it("each file is its Prisma migration verbatim under one generated header", () => {
    for (const f of deskFolders) {
      const body = read(path.join(prismaDir, f, "migration.sql"));
      const copy = read(path.join(migDir, `${f}.sql`));
      expect(copy.startsWith("-- Generated from prisma/migrations/"), f).toBe(true);
      expect(copy.endsWith(body), `${f} differs from its Prisma migration: run npm run db:export-supabase`).toBe(true);
    }
  });

  it("leaves out the destructive retire migration, and the retired backhaul folders", () => {
    expect(mirrored.some((f) => f.includes("retire_legacy"))).toBe(false);
    expect(mirrored.every((f) => f.slice(0, 14) >= "20261027000000")).toBe(true);
  });

  it("apply-all.sql holds every file in order", () => {
    const all = read(path.join(root, "supabase", "apply-all.sql"));
    let at = -1;
    for (const f of mirrored) {
      const i = all.indexOf(`-- ${f}\n`);
      expect(i, `${f} is missing from apply-all.sql`).toBeGreaterThan(at);
      at = i;
    }
  });

  it("the lockdown turns row security on for every table in public, with no policy, and is also kept alone to re-run", () => {
    const rls = read(path.join(migDir, "20261129000000_enable_rls.sql"));
    expect(rls).toContain("schemaname = 'public'");
    expect(rls).toContain("enable row level security");
    expect(rls).not.toMatch(/create policy/i);
    expect(read(path.join(root, "supabase", "lockdown_rls.sql"))).toBe(rls);
  });

  it("the preflight creates pg_trgm before the indexes that need it", () => {
    expect(read(path.join(migDir, "20261027000000_extensions.sql"))).toContain("create extension if not exists pg_trgm");
    expect(read(path.join(prismaDir, "20261106100000_scale_indexes_terminals", "migration.sql"))).toContain("gin_trgm_ops");
  });

  it("the Prisma-history scripts name every desk folder, the retire one included", () => {
    const sh = read(path.join(root, "supabase", "mark-applied.sh"));
    const ps = read(path.join(root, "supabase", "mark-applied.ps1"));
    for (const f of [...deskFolders, RETIRE]) {
      expect(sh, f).toContain(f);
      expect(ps, f).toContain(f);
    }
  });

  it("the folder never tells anyone to use the phone's project", () => {
    const readme = read(path.join(root, "supabase", "README.md"));
    expect(readme).toContain("truelane-prod");
    expect(readme).toMatch(/Do not paste any of this into `truelane-prod`/);
  });
});
