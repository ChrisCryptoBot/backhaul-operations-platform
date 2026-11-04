import { NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { canAny, cleanGrants, whoCan, type Capability, type Role } from "@/lib/roles";
import { authOn, sessionIdentity, type Identity } from "./identity";
import { currentWorkspaceId } from "./workspace";

/**
 * Who may do what, asked of the member table every time. A session cookie says who someone was a minute ago; the table says whether they are still on the desk and as what, so
 * taking a person off the desk (or lowering their role or taking their grants away) takes effect on their very next click, not when a cookie runs out. With sign-in off everyone is the demo's admin.
 */
export type Access = { ok: true; identity: Identity } | { ok: false; reason: "signed_out" | "no_member" | "forbidden" };

export const DEMO_NAME = "Dispatcher";

/**
 * Whether the person may do at least one of `capabilities` (default: read). The role and the grants are the member table's, not the cookie's.
 * Which capability a thing needs is lib/roles.ts's matrix; asking for two means either is enough (a screen two offices share).
 */
export async function checkAccess(...capabilities: Capability[]): Promise<Access> {
  const needs: Capability[] = capabilities.length > 0 ? capabilities : ["read"];
  if (!authOn()) return { ok: true, identity: { userId: "demo", workspaceId: currentWorkspaceId(), role: "admin", grants: [], name: DEMO_NAME, email: null } };
  const id = sessionIdentity();
  if (!id) return { ok: false, reason: "signed_out" };
  const m = await prisma.member.findFirst({ where: { clerkUserId: id.userId, workspaceId: id.workspaceId }, select: { role: true, grants: true, name: true, email: true } });
  if (!m) return { ok: false, reason: "no_member" };
  const role = m.role as Role;
  const grants = cleanGrants(m.grants);
  if (!canAny(role, grants, needs)) return { ok: false, reason: "forbidden" };
  return { ok: true, identity: { ...id, role, grants, name: m.name || id.name, email: m.email ?? id.email } };
}

export class AccessError extends Error {
  constructor(public reason: "no_member" | "forbidden", needs: readonly Capability[] = []) {
    super(reason === "forbidden" ? `Your role on this desk does not allow that.${needs.length > 0 ? ` ${whoCan(needs[0]!)} can.` : " Ask an admin."}` : "You are not on this desk.");
    this.name = "AccessError";
  }
}

/** For a server action: the person, or a redirect to sign in, or an error saying the role does not allow it and who can. The first line of every action. */
export async function requireCan(...capabilities: Capability[]): Promise<Identity> {
  const a = await checkAccess(...capabilities);
  if (a.ok) return a.identity;
  if (a.reason === "signed_out") redirect("/sign-in");
  throw new AccessError(a.reason, capabilities);
}

/** For a page or a layout: the person, or the page that says what to do (sign in, or no desk yet); a role that may not see it gets the not-found page. */
export async function requirePage(...capabilities: Capability[]): Promise<Identity> {
  const a = await checkAccess(...capabilities);
  if (a.ok) return a.identity;
  if (a.reason === "signed_out") redirect("/sign-in");
  if (a.reason === "no_member") redirect("/no-workspace");
  notFound();
}

/** For a route handler: null when the caller may go on, otherwise the answer to send (401 not signed in, 403 not allowed). The first line of every route. */
export async function guardRoute(...capabilities: Capability[]): Promise<NextResponse | null> {
  const a = await checkAccess(...capabilities);
  if (a.ok) return null;
  const signedOut = a.reason === "signed_out";
  return NextResponse.json({ ok: false, error: signedOut ? "Sign in to use the desk." : a.reason === "forbidden" ? `Your role on this desk does not allow that.${capabilities.length > 0 ? ` ${whoCan(capabilities[0]!)} can.` : ""}` : "You are not on this desk." }, { status: signedOut ? 401 : 403 });
}

/**
 * The people who run TrueLane (not a customer's own admins) may see what belongs to the platform: who has asked for an account. They are named by DESK_ADMIN_EMAILS, a comma list.
 * With sign-in off the demo shows everything.
 */
export function isPlatformAdmin(identity: Identity): boolean {
  if (!authOn()) return true;
  const list = (process.env.DESK_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return identity.email != null && list.includes(identity.email.toLowerCase());
}
