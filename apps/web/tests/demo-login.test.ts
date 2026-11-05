import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_COOKIE, demoDecide, demoLoginOn } from "@/lib/demo-session";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
const page = { method: "GET", wantsHtml: true };

describe("the demo door (sign-in off)", () => {
  it("is on by default, off with DEMO_LOGIN=off, and never on when real sign-in is", () => {
    expect(demoLoginOn({})).toBe(true);
    expect(demoLoginOn({ DEMO_LOGIN: "off" })).toBe(false);
    expect(demoLoginOn({ DESK_AUTH: "on" })).toBe(false);
    expect(demoLoginOn({ DESK_AUTH: "on", DEMO_LOGIN: "on" })).toBe(false);
  });

  it("sends a page with no demo cookie to the sign-in page, and turns a fetch or a change away with a 401", () => {
    expect(demoDecide({ ...page, path: "/loads", hasDemo: false })).toEqual({ kind: "sign_in" });
    expect(demoDecide({ ...page, path: "/quote", hasDemo: false })).toEqual({ kind: "sign_in" });
    expect(demoDecide({ method: "GET", wantsHtml: false, path: "/search", hasDemo: false })).toEqual({ kind: "unauthorized" });
    expect(demoDecide({ method: "POST", wantsHtml: true, path: "/loads", hasDemo: false })).toEqual({ kind: "unauthorized" });
  });

  it("lets the public pages, the demo sign-in and signing out through, and everything once the cookie is there", () => {
    for (const p of ["/", "/sign-in", "/sign-up", "/enterprise", "/auth/leave", "/auth/demo"]) expect(demoDecide({ ...page, path: p, hasDemo: false }).kind, p).toBe("next");
    expect(demoDecide({ ...page, path: "/loads", hasDemo: true }).kind).toBe("next");
    expect(DEMO_COOKIE).toBe("desk-demo");
  });
});

describe("the demo sign-in and sign-out are wired", () => {
  it("the sign-in page offers the demo button only when the demo door is on, and the button posts to the demo route", () => {
    const page = src("src/app/(public)/sign-in/page.tsx");
    expect(page).toContain("demoLoginOn(process.env)");
    expect(page).toContain("<DemoSignIn");
    const form = src("src/components/desk/public/demo-sign-in.tsx");
    expect(form).toContain('action="/auth/demo"');
    expect(form).toContain("Demo as ${u.label}"); // one button for each way of using the desk (src/lib/demo-session.ts)
    expect(form).toContain("DEMO_USERS");
    expect(form).toContain("requestSubmit");
  });

  it("the demo route refuses when the door is off, checks nothing, and makes only the plain demo cookie", () => {
    const route = src("src/app/(public)/auth/demo/route.ts");
    expect(route).toMatch(/if \(!demoLoginOn\(process\.env\)\) return NextResponse\.json\([^)]*status: 404/);
    expect(route).toContain("DEMO_COOKIE");
    expect(route).not.toMatch(/signSession|DESK_SESSION_SECRET/);
    expect(route).toContain("safeNext");
  });

  it("signing out removes the demo cookie as well as the desk's own and lands on the sign-in page; the shell links to it with a plain anchor (a prefetch must not sign anyone out)", () => {
    const leave = src("src/app/(public)/auth/leave/route.ts");
    expect(leave).toContain("DEMO_COOKIE");
    expect(leave).toContain('"/sign-in"');
    const shell = src("src/components/desk/desk-shell.tsx");
    expect(shell).toContain('<a href="/auth/leave" className="t-mid">Sign out</a>');
    expect(shell).not.toMatch(/<Link[^>]*href="\/auth\/leave"/);
  });
});
