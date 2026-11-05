import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_USERS, demoLoginOn, demoUserOf } from "@/lib/demo-session";
import { ROLES, can } from "@/lib/roles";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

// The demo desk reads who it is from a cookie. Stand a cookie in, with no database: the demo branch answers before any query.
let cookie: string | undefined;
vi.mock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name === "desk-demo" && cookie != null ? { value: cookie } : undefined) }), headers: () => new Headers() }));

describe("the demo's people", () => {
  it("is one button for each way of using the desk, each a real role, each landing where that job starts", () => {
    expect(DEMO_USERS.map((u) => [u.key, u.role, u.landing])).toEqual([
      ["admin", "admin", "/loads"],
      ["dispatcher", "dispatcher", "/dispatch"],
      ["accounting", "accounting", "/invoices"],
      ["viewer", "viewer", "/loads"]
    ]);
    expect(new Set(DEMO_USERS.map((u) => u.role)).size).toBe(ROLES.length);
    expect(new Set(DEMO_USERS.map((u) => u.email)).size).toBe(DEMO_USERS.length);
  });

  it("a cookie is one of those people, the old plain cookie is still the admin, and anything else is nobody", () => {
    expect(demoUserOf("dispatcher")?.role).toBe("dispatcher");
    expect(demoUserOf("1")?.role).toBe("admin");
    for (const bad of [undefined, null, "", "root", "ADMIN", "admin ", "0"]) expect(demoUserOf(bad as string), String(bad)).toBeNull();
  });

  it("is on with sign-in off and gone with sign-in on, as before", () => {
    expect(demoLoginOn({})).toBe(true);
    expect(demoLoginOn({ DESK_AUTH: "on" })).toBe(false);
  });
});

describe("the demo desk holds each person to the real role matrix", () => {
  beforeEach(() => {
    cookie = undefined;
    delete process.env.DESK_AUTH;
  });

  const ask = async (who: string | undefined, ...caps: Parameters<typeof can>[2][]) => {
    cookie = who;
    const { checkAccess } = await import("@/server/tl/access");
    return checkAccess(...caps);
  };

  it("an admin, and a script or a test with no cookie, may do anything", async () => {
    for (const who of ["admin", "1", undefined]) {
      for (const cap of ["admin", "dispatch", "bill", "payout", "writeoff"] as const) expect(await ask(who, cap), `${who} ${cap}`).toMatchObject({ ok: true });
    }
  });

  it("a dispatcher dispatches and quotes, and is refused billing, payouts and the admin's work", async () => {
    expect(await ask("dispatcher", "dispatch")).toMatchObject({ ok: true, identity: { role: "dispatcher", name: "Dispatcher" } });
    expect(await ask("dispatcher", "quote")).toMatchObject({ ok: true });
    for (const cap of ["bill", "payout", "writeoff", "admin"] as const) expect(await ask("dispatcher", cap), cap).toEqual({ ok: false, reason: "forbidden" });
  });

  it("the billing office bills and pays out, and is refused dispatching and the admin's work", async () => {
    expect(await ask("accounting", "bill")).toMatchObject({ ok: true, identity: { role: "accounting", name: "Demo billing" } });
    expect(await ask("accounting", "payout")).toMatchObject({ ok: true });
    for (const cap of ["dispatch", "quote", "admin", "writeoff"] as const) expect(await ask("accounting", cap), cap).toEqual({ ok: false, reason: "forbidden" });
  });

  it("a viewer reads and nothing else", async () => {
    expect(await ask("viewer")).toMatchObject({ ok: true, identity: { role: "viewer" } });
    for (const cap of ["dispatch", "bill", "quote", "documents", "admin"] as const) expect(await ask("viewer", cap), cap).toEqual({ ok: false, reason: "forbidden" });
  });

  it("what the demo refuses is exactly what the matrix refuses", async () => {
    for (const u of DEMO_USERS) {
      for (const cap of ["read", "quote", "dispatch", "documents", "figures", "billing_details", "bill", "payout", "writeoff", "admin"] as const) {
        expect((await ask(u.key, cap)).ok, `${u.key} ${cap}`).toBe(can(u.role, [], cap));
      }
    }
  });
});

describe("what each person is shown", () => {
  const shell = src("src/components/desk/desk-shell.tsx");

  it("the rail hides what a role does not use, and a heading with nothing under it", () => {
    expect(shell).toContain("i.roles.includes(role as Role)");
    expect(shell).toContain(".filter((group) => group.items.length > 0)");
    // Dispatching is not for the billing office; billing is not for a dispatcher.
    expect(shell).toMatch(/label: "Quote a load"[^}]*roles: \["admin", "dispatcher"\]/);
    expect(shell).toMatch(/label: "Payroll"[^}]*roles: \["admin", "accounting"\]/);
    expect(shell).toMatch(/label: "Settlements"[^}]*roles: \["admin", "accounting"\]/);
  });

  it("Settings is tabs, and the company, plan, team and integrations are only offered to an admin", () => {
    const page = src("src/app/(desk)/settings/page.tsx");
    expect(page).toContain("<SettingsTabs");
    expect(page).toMatch(/\.\.\.\(admin \? \[\{ key: "company"[^\]]*key: "integrations"[^\]]*\] : \[\]\)/s);
    expect(page).toContain('{ key: "display"');
    expect(page).toContain('{ key: "rules"');
  });

  it("only a platform admin sees the sign-up requests, and in the demo that is only the admin", () => {
    expect(src("src/server/tl/access.ts")).toMatch(/if \(!authOn\(\)\) return identity\.role === "admin"/);
  });
});
