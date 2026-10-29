import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for the rebuild. The old coordinator-task app (copilot, regions and weeks, drop lots, AWS queues, Clerk) and the
 * employer it was built for are gone on purpose. This fails if their names or their architecture come back into the code.
 * Migrations are history and are not scanned; docs may tell the story but never name the employer.
 */
const repo = path.join(__dirname, "../../..");
const web = path.join(__dirname, "..");

// Built from pieces so this file does not trip its own scan.
const j = (...p: string[]) => p.join("");
const EMPLOYER = new RegExp([j("Mile", "Max"), j("Carl", "isle"), j("Lees", "port"), j("Sealed", " Air"), j("Ash", "ley"), j("AW", "LE"), j("Drop", " ?Bucket")].join("|"), "i");
const LEGACY = new RegExp(
  [j("co", "pilot"), j("Phase", "1"), j("mg", "Status"), j("tmw", "Status"), j("manual_", "tuesday"), j("Week", "Snapshot"), j("Drop", "Lot"), j("runIn", "RegionScope"), j("@cl", "erk"), j("@aws", "-sdk"), j("S3_", "BUCKET"), j("SQS", "_"), j("AWS", "_REGION")].join("|"),
  "i"
);

function walk(dir: string, skip: (p: string) => boolean, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (skip(full)) continue;
    if (e.isDirectory()) walk(full, skip, out);
    else if (/\.(ts|tsx|css|mjs|md|json|yml|prisma|sql|example)$/.test(e.name) || e.name === ".env.example") out.push(full);
  }
  return out;
}

const SKIP = (p: string) => /node_modules|[\/]\.next|[\/]\.git[\/]|package-lock\.json|tsbuildinfo/.test(p) || p.endsWith(`${path.sep}.git`);
const rel = (f: string) => path.relative(repo, f).split(path.sep).join("/");
const self = path.join(__dirname, "no-legacy.test.ts");

describe("the old app and its employer are gone", () => {
  it("names the employer nowhere in the repo outside migration history", () => {
    const files = walk(repo, (p) => SKIP(p) || p.includes(`${path.sep}migrations${path.sep}`)).filter((f) => f !== self);
    const hits = files.filter((f) => EMPLOYER.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });

  it("carries none of the old architecture in code, config or the README", () => {
    const code = [...walk(path.join(web, "src"), SKIP), ...walk(path.join(web, "tests"), SKIP), ...walk(path.join(web, "scripts"), SKIP), ...walk(path.join(repo, "prisma"), (p) => SKIP(p) || p.includes(`${path.sep}migrations${path.sep}`))];
    for (const f of ["README.md", ".env.example", "vercel.json", "package.json", path.join("apps", "web", "package.json"), path.join(".github", "workflows", "ci.yml")]) code.push(path.join(repo, f));
    const hits = code.filter((f) => f !== self && LEGACY.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });

  it("has no old route, module or component on disk", () => {
    for (const p of ["src/app/api", "src/app/(auth)", "src/server/copilot", "src/components/copilot", "src/middleware.ts", "src/domain", "src/contracts"]) {
      expect(fs.existsSync(path.join(web, p)), p).toBe(false);
    }
  });

  it("keeps the schema to the TrueLane-shaped models plus the desk's own audit trail", () => {
    const schema = fs.readFileSync(path.join(repo, "prisma", "schema.prisma"), "utf8");
    const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]).sort();
    // AuditEvent is the one model that is not TrueLane's: the desk's own record of what it did and why (added in Wave 2).
    expect(models).toEqual(["Assignment", "AuditEvent", "CostProfile", "Driver", "Load", "LoadDecision", "Stop", "TripSegment", "Vehicle", "Workspace"]);
  });
});
