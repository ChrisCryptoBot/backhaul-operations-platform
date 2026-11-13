import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The read API's tenancy, by its source (money plan Wave 7 step 2): nothing under the public API routes or src/server/api may reach for a person's session, a cookie, the sign-in provider or
 * the request's default workspace. The workspace comes from the key, and every reader takes it as a required parameter. (At run time explicitTenancy makes a slip a thrown error as well;
 * tests/api-keys.test.ts proves that.)
 */
const root = path.join(__dirname, "..", "src");
// The outbound webhooks (Wave 7 step 3) run from the schedule with no person at all, so they are held to the same rule.
const DIRS = [path.join(root, "app", "(public)", "api"), path.join(root, "server", "api"), path.join(root, "server", "webhooks")];
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
};
const files = DIRS.flatMap((d) => walk(d));
const rel = (p: string) => path.relative(root, p).replace(/\\/g, "/");

describe("the read API never reads a person's session or the default workspace", () => {
  test("the folders exist and hold the four routes and the server half", () => {
    const names = files.map(rel).sort();
    for (const s of ["invoices", "payments", "settlements", "loads"]) expect(names).toContain(`app/(public)/api/v1/${s}/route.ts`);
    for (const f of ["handler.ts", "keys.ts", "reads.ts"]) expect(names).toContain(`server/api/${f}`);
    for (const f of ["emit.ts", "deliver.ts", "endpoints.ts", "transport.ts"]) expect(names).toContain(`server/webhooks/${f}`);
  });

  test("no file names currentWorkspaceId, cookies, next/headers, the Clerk SDK, or the desk's session and access helpers", () => {
    const banned: Array<[RegExp, string]> = [
      [/\bcurrentWorkspaceId\b/, "currentWorkspaceId"],
      [/\bcurrentWorkspace\b/, "currentWorkspace"],
      [/\bcookies\b/, "cookies"],
      [/["']next\/headers["']/, "next/headers"],
      [/@clerk\//, "@clerk"],
      [/\bclerkSeam\b|\bsessionIdentity\b|\bverifySession\b/, "the desk session"],
      [/\brequireCan\b|\brequirePage\b|\bcheckAccess\b|\bguardRoute\b/, "a person's access check"],
      [/@\/server\/tl\/identity["']/, "server/tl/identity"]
    ];
    const hits: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const [re, what] of banned) if (re.test(text)) hits.push(`${rel(f)}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  test("every function in src/server/api and src/server/webhooks that takes a workspace takes it without a default", () => {
    const loose: string[] = [];
    for (const f of files.filter((p) => rel(p).startsWith("server/"))) {
      const text = fs.readFileSync(f, "utf8");
      // a parameter with a default (workspaceId: string = ..., or workspaceId = ...) in a function's parameter list
      if (/[(,]\s*workspaceId\s*(:\s*string\s*)?=(?!=)/.test(text)) loose.push(rel(f));
    }
    expect(loose).toEqual([]);
  });

  test("the handler runs every read inside explicitTenancy", () => {
    const h = fs.readFileSync(path.join(root, "server", "api", "handler.ts"), "utf8");
    const at = h.indexOf("READERS[scope](");
    expect(at).toBeGreaterThan(0);
    expect(h.lastIndexOf("explicitTenancy(workspaceId", at)).toBeGreaterThan(0);
    expect(h.indexOf("authenticate(")).toBeLessThan(h.indexOf("explicitTenancy(workspaceId"));
  });
});
