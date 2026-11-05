import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing on the desk is reachable without being asked of the member table. Every server action starts with `requireCan`, every route handler with `guardRoute` (but the
 * two that make and end the session), and the desk layout with `requirePage`. A new action or route that skips the check is how the desk gets a hole, so this reads the source
 * and fails on one.
 */
const SRC = path.join(__dirname, "..", "src");

function files(dir: string, test: (f: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "truelane" ? [] : files(full, test);
    return test(full) ? [full] : [];
  });
}
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

describe("every server action asks who is calling", () => {
  const text = read(path.join(SRC, "app", "(desk)", "actions.ts"));
  const names = [...text.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]!);

  it("sees the actions (a scan that finds nothing proves nothing)", () => {
    expect(names.length).toBeGreaterThanOrEqual(55);
  });

  it("starts each one with requireCan", () => {
    const bare = names.filter((n) => {
      const at = text.indexOf(`export async function ${n}`);
      const open = text.indexOf("{\n", text.indexOf(")", at));
      const next = text.slice(at).search(/\n(?=export |\/\/ ──)/);
      const body = text.slice(open, next < 0 ? undefined : at + next);
      return !/^\{\n\s+await requireCan\("\w+"(, "\w+")*\);/.test(body);
    });
    expect(bare, "Start the action with `await requireCan(capability)` (src/server/tl/access.ts; the capabilities are in src/lib/roles.ts).").toEqual([]);
  });

  it("pins the capability each Quote action needs: pricing is for anyone who can read, everything that writes is for someone who may quote", () => {
    const caps: Record<string, "read" | "quote"> = { priceQuoteAction: "read", listQuotesAction: "read", saveQuoteAction: "quote", bookQuoteAction: "quote", passQuoteAction: "quote", discardQuoteAction: "quote" };
    for (const [n, cap] of Object.entries(caps)) {
      const at = text.indexOf(`export async function ${n}`);
      expect(at, n).toBeGreaterThan(-1);
      expect(text.slice(at, at + 400), n).toContain(`requireCan("${cap}")`);
    }
  });

  it("keeps the changes that reach the company, the rules, the connections and the team to admins", () => {
    for (const n of ["saveThresholdsAction", "saveCompanyAction", "connectPartnerAction", "disconnectPartnerAction", "addMemberAction", "setMemberRoleAction", "removeMemberAction", "setMemberGrantsAction"]) {
      const at = text.indexOf(`export async function ${n}`);
      expect(at, n).toBeGreaterThan(-1);
      expect(text.slice(at, at + 600), n).toContain('requireCan("admin")');
    }
  });
});

describe("every route handler asks who is calling", () => {
  const OPEN = new Set(["app/(public)/auth/enter/route.ts", "app/(public)/auth/leave/route.ts", "app/(public)/auth/demo/route.ts"]);
  const routes = files(SRC, (f) => /[\\/]route\.ts$/.test(f));

  it("sees the routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(14);
  });

  it("guards each one, except those that make and end the session (and the demo's)", () => {
    const bare = routes.filter((f) => !OPEN.has(rel(f))).filter((f) => !/await guardRoute\("\w+"(, "\w+")*\)/.test(read(f))).map(rel);
    expect(bare, "Start the handler with `const denied = await guardRoute(role); if (denied) return denied;`").toEqual([]);
  });

  it("budgets the ones that spend a paid lookup", () => {
    for (const r of ["fmcsa/lookup", "fuel/eia", "geo/measure", "geo/suggest"]) expect(read(path.join(SRC, "app", "(desk)", r, "route.ts")), r).toContain("overBudget(");
  });
});

describe("the desk as a whole", () => {
  it("renders nothing for anyone who is not a member: the layout asks first", () => {
    expect(read(path.join(SRC, "app", "(desk)", "layout.tsx"))).toMatch(/await requirePage\("read"\)[\s\S]*getShellData\(\)/);
  });

  it("keeps who has asked for an account to the people who run TrueLane", () => {
    expect(read(path.join(SRC, "app", "(desk)", "settings", "requests", "page.tsx"))).toContain("isPlatformAdmin(");
  });

  it("reads the workspace from the signed-in person with sign-in on, and ignores the cookie seam in production", () => {
    const seam = read(path.join(SRC, "server", "tl", "workspace.ts"));
    expect(seam).toContain("authOn()");
    expect(seam).toContain('process.env.NODE_ENV === "production"');
  });

  it("imports the sign-in provider in no more than the files that must", () => {
    const allowed = new Set(["middleware.ts", "server/tl/clerk.ts", "app/layout.tsx", "app/(public)/sign-in/page.tsx", "components/desk/auth-sign-out.tsx"]);
    const using = files(SRC, (f) => /\.(ts|tsx)$/.test(f)).filter((f) => /from "@clerk\//.test(read(f))).map(rel);
    expect(using.filter((f) => !allowed.has(f))).toEqual([]);
    expect(using.length).toBe(allowed.size);
  });
});
