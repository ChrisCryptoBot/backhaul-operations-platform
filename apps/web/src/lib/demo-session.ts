import { isPublicPath } from "./auth-route";
import type { Role } from "./roles";

/**
 * The demo's front door. With sign-in off (DESK_AUTH not on) there are no accounts, but the demo still has a sign-in page and a Sign out: signing in is one button that
 * makes a plain cookie, and signing out removes it and goes back to the sign-in page. The cookie proves nothing about anyone and grants nothing: it is the demo desk's own
 * "I have come in", for invented data only. With DESK_AUTH on it is never read or made (the real sign-in decides), and DEMO_LOGIN=off turns the demo door off altogether.
 * Pure, so the middleware (edge) and the tests share it.
 */
export const DEMO_COOKIE = "desk-demo";
export const DEMO_TTL_SECONDS = 8 * 3600;
/** Shown in the sign-in form's fields by the demo button. Display only: nothing is checked against them. */
export const DEMO_EMAIL = "demo@truelane.example";
export const DEMO_PASSWORD = "demo-desk";

/**
 * The demo's people: one button for each way of using the desk. The cookie holds the key, and the demo desk then behaves as that role: the same role matrix the real desk enforces (lib/roles.ts),
 * so what a dispatcher cannot do is refused here exactly as it would be for a real one. `1` is the cookie the demo made before there were roles, and stays an admin.
 */
export type DemoUser = { key: string; label: string; role: Role; name: string; email: string; landing: string; blurb: string };

export const DEMO_USERS: readonly DemoUser[] = [
  { key: "admin", label: "Admin", role: "admin", name: "Demo admin", email: "admin@demo.truelane.example", landing: "/loads", blurb: "Everything, including the company, the plan, the team, the integrations and the thresholds." },
  { key: "dispatcher", label: "Dispatcher", role: "dispatcher", name: "Dispatcher", email: "dispatch@demo.truelane.example", landing: "/dispatch", blurb: "Quotes, books, assigns and sends loads, and enters what the driver did. No billing, no company settings." },
  { key: "accounting", label: "Billing", role: "accounting", name: "Demo billing", email: "billing@demo.truelane.example", landing: "/invoices", blurb: "Invoices, payments, driver statements and payroll. Cannot dispatch." },
  { key: "viewer", label: "Viewer", role: "viewer", name: "Demo viewer", email: "viewer@demo.truelane.example", landing: "/loads", blurb: "Looks at everything and changes nothing." }
];

const LEGACY_USER: DemoUser = { key: "1", label: "Admin", role: "admin", name: "Dispatcher", email: DEMO_EMAIL, landing: "/loads", blurb: "" };

/** The person a demo cookie stands for, or null when it is not one the demo made. */
export function demoUserOf(value: string | null | undefined): DemoUser | null {
  if (!value) return null;
  if (value === "1") return LEGACY_USER;
  return DEMO_USERS.find((u) => u.key === value) ?? null;
}

export const demoLoginOn = (env: Record<string, string | undefined>): boolean => env.DESK_AUTH !== "on" && env.DEMO_LOGIN !== "off";

export type DemoDoor = { kind: "next" } | { kind: "sign_in" } | { kind: "unauthorized" };

/** What the demo door does with a request: the public pages, the demo sign-in and signing out are open; anything else needs the demo cookie. */
export function demoDecide(i: { path: string; method: string; hasDemo: boolean; wantsHtml: boolean }): DemoDoor {
  if (isPublicPath(i.path) || i.path === "/auth/demo") return { kind: "next" };
  if (i.hasDemo) return { kind: "next" };
  return i.method === "GET" && i.wantsHtml ? { kind: "sign_in" } : { kind: "unauthorized" };
}
