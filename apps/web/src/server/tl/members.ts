import { prisma } from "@/lib/db";
import { GRANT_LABEL, ROLE_LABEL, cleanGrants, isRole, type Grant, type Role } from "@/lib/roles";
import { recordAudit } from "./audit";
import type { ClerkProfile } from "./clerk";
import { lockWorkspace, roomFor } from "./plan";
import { currentWorkspaceId } from "./workspace";

/**
 * The people on a desk. An admin adds a person by email and role before they have signed in (a seat of the plan); the first verified sign-in with that email binds the
 * provider's user id to the row, and from then on the user id is what is matched. A desk always keeps one admin. A dispatcher can carry the grant "Can also bill". Every change is one transaction with its audit event.
 */
export type MemberRow = { id: string; email: string; name: string; role: Role; grants: Grant[]; signedIn: boolean; lastSeenAt: Date | null };
export type MemberResult = { ok: true; id: string } | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanEmail = (s: string) => s.trim().toLowerCase();

export async function listMembers(workspaceId = currentWorkspaceId()): Promise<MemberRow[]> {
  const rows = await prisma.member.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "asc" }] });
  return rows.map((m) => ({ id: m.id, email: m.email, name: m.name, role: m.role as Role, grants: cleanGrants(m.grants), signedIn: m.clerkUserId != null, lastSeenAt: m.lastSeenAt }));
}

export async function addMember(input: { email: string; name: string; role: string; grants?: string[] }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<MemberResult> {
  const email = cleanEmail(input.email);
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!EMAIL.test(email) || email.length > 120) return { ok: false, error: "Type the person's email address." };
  if (name.length < 1 || name.length > 80) return { ok: false, error: "Type the person's name." };
  if (!isRole(input.role)) return { ok: false, error: "Pick a role from the list." };
  const role: Role = input.role;
  // A grant only means something for a dispatcher (the other roles either have the work already or may not have it).
  const grants = role === "dispatcher" ? cleanGrants(input.grants) : [];
  const elsewhere = await prisma.member.findFirst({ where: { email }, select: { workspaceId: true } });
  if (elsewhere) return { ok: false, error: elsewhere.workspaceId === workspaceId ? "That person is already on this desk." : "That person is already on another desk. A person works on one desk." };
  const out = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const room = await roomFor("member", 1, workspaceId, tx);
    if (!room.ok) return room;
    const m = await tx.member.create({ data: { workspaceId, email, name, role, grants } });
    await recordAudit({ entity: "settings", action: "member_added", summary: `${name} (${email}) added as ${ROLE_LABEL[role].toLowerCase()}${grants.length > 0 ? `, ${grants.map((g) => GRANT_LABEL[g].toLowerCase()).join(", ")}` : ""}`, before: null, after: { Name: name, Email: email, Role: ROLE_LABEL[role], ...(grants.length > 0 ? { Grants: grants.map((g) => GRANT_LABEL[g]).join(", ") } : {}) }, at: now, workspaceId }, tx);
    return m;
  });
  return "ok" in out ? { ok: false, error: out.message } : { ok: true, id: out.id };
}

const adminsOf = (tx: Pick<typeof prisma, "member">, workspaceId: string) => tx.member.count({ where: { workspaceId, role: "admin" } });

export async function setMemberRole(id: string, role: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<MemberResult> {
  if (!isRole(role)) return { ok: false, error: "Pick a role from the list." };
  return prisma.$transaction(async (tx) => {
    const m = await tx.member.findFirst({ where: { id, workspaceId } });
    if (!m) return { ok: false as const, error: "That person is not on this desk." };
    if (m.role === role) return { ok: true as const, id };
    if (m.role === "admin" && (await adminsOf(tx, workspaceId)) <= 1) return { ok: false as const, error: "A desk keeps one admin. Make someone else an admin first." };
    // Grants only belong to a dispatcher: a person who is made something else loses them, so they cannot come back by changing the role again.
    await tx.member.update({ where: { id }, data: { role, ...(role === "dispatcher" ? {} : { grants: [] }) } });
    await recordAudit({ entity: "settings", action: "member_role_changed", summary: `${m.name}: ${ROLE_LABEL[m.role as Role].toLowerCase()} to ${ROLE_LABEL[role].toLowerCase()}`, before: { Role: ROLE_LABEL[m.role as Role] }, after: { Role: ROLE_LABEL[role] }, at: now, workspaceId }, tx);
    return { ok: true as const, id };
  });
}

export async function removeMember(id: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<MemberResult> {
  return prisma.$transaction(async (tx) => {
    const m = await tx.member.findFirst({ where: { id, workspaceId } });
    if (!m) return { ok: false as const, error: "That person is not on this desk." };
    if (m.role === "admin" && (await adminsOf(tx, workspaceId)) <= 1) return { ok: false as const, error: "A desk keeps one admin. Make someone else an admin first." };
    await tx.member.delete({ where: { id } });
    await recordAudit({ entity: "settings", action: "member_removed", summary: `${m.name} (${m.email}) removed from the desk`, before: { Name: m.name, Email: m.email, Role: ROLE_LABEL[m.role as Role] }, after: null, at: now, workspaceId }, tx);
    return { ok: true as const, id };
  });
}

/**
 * The member a signed-in person is: the row bound to their provider user id, or else the row added for their (verified) email, which is bound to them now. Null when neither
 * exists, which is a person who signed in with nobody having added them. An email the provider has not verified is never matched.
 */
export async function memberForSignIn(profile: ClerkProfile, now = new Date()) {
  const bound = await prisma.member.findUnique({ where: { clerkUserId: profile.id } });
  if (bound) return prisma.member.update({ where: { id: bound.id }, data: { lastSeenAt: now } });
  if (!profile.email || !profile.emailVerified) return null;
  const added = await prisma.member.findFirst({ where: { email: profile.email.toLowerCase(), clerkUserId: null } });
  if (!added) return null;
  // The row is claimed only if it is still unbound (two sign-ins at once cannot both take it).
  const claimed = await prisma.member.updateMany({ where: { id: added.id, clerkUserId: null }, data: { clerkUserId: profile.id, lastSeenAt: now } });
  return claimed.count === 1 ? prisma.member.findUnique({ where: { id: added.id } }) : null;
}

/** An admin lets a dispatcher do the billing office's work, or takes it back. Audited; only a dispatcher can carry a grant. */
export async function setMemberGrants(id: string, grants: string[], now = new Date(), workspaceId = currentWorkspaceId()): Promise<MemberResult> {
  const next = cleanGrants(grants);
  return prisma.$transaction(async (tx) => {
    const m = await tx.member.findFirst({ where: { id, workspaceId } });
    if (!m) return { ok: false as const, error: "That person is not on this desk." };
    if (m.role !== "dispatcher") return { ok: false as const, error: "Only a dispatcher is given extra permissions. An accounting person or an admin already has the work." };
    const was = cleanGrants(m.grants);
    if (was.length === next.length && was.every((g) => next.includes(g))) return { ok: true as const, id };
    await tx.member.update({ where: { id }, data: { grants: next } });
    const words = (g: Grant[]) => (g.length === 0 ? "None" : g.map((x) => GRANT_LABEL[x]).join(", "));
    await recordAudit({ entity: "settings", action: "member_role_changed", summary: `${m.name}: extra permissions ${words(was).toLowerCase()} to ${words(next).toLowerCase()}`, before: { Permissions: words(was) }, after: { Permissions: words(next) }, at: now, workspaceId }, tx);
    return { ok: true as const, id };
  });
}
