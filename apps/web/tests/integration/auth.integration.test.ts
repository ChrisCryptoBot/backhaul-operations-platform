import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { signSession } from "@/server/tl/session-token";

/**
 * Sign-in on, with a stand-in for the provider and the request's cookie: who may be on a desk, as what, and how soon a change of that takes effect. The provider is never called;
 * `state` says who is signed in to it and what the request's cookie holds.
 */
const SECRET = "x".repeat(40);
const W = "auth-ws";
const OTHER = "auth-other";
const state = vi.hoisted(() => ({ uid: null as string | null, cookie: undefined as string | undefined, profile: null as null | { id: string; name: string | null; email: string | null; emailVerified: boolean } }));

vi.mock("@/server/tl/clerk", () => ({ clerkSeam: { userId: () => state.uid, profile: async () => state.profile } }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: (n: string) => (n === "desk-session" && state.cookie ? { value: state.cookie } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { to });
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  }
}));

const run = process.env.RUN_DB_INTEGRATION === "true";
const cookieFor = (role: "viewer" | "dispatcher" | "owner", uid = "user-1", ws = W, ttl = 3600) =>
  signSession({ uid, ws, role, name: "Pat Lee", email: "pat@example.com" }, SECRET, Date.now(), ttl);

describe.skipIf(!run)("sign-in on: who is on a desk", () => {
  beforeAll(async () => {
    vi.stubEnv("DESK_AUTH", "on");
    vi.stubEnv("DESK_SESSION_SECRET", SECRET);
    await prisma.workspace.deleteMany({ where: { id: { in: [W, OTHER] } } });
    await prisma.workspace.create({ data: { id: W, name: "Auth desk", plan: "growth" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "Other desk", plan: "starter" } });
  });
  beforeEach(async () => {
    state.uid = null;
    state.cookie = undefined;
    state.profile = null;
    await prisma.auditEvent.deleteMany({ where: { workspaceId: { in: [W, OTHER] } } });
    await prisma.member.deleteMany({ where: { workspaceId: { in: [W, OTHER] } } });
  });
  afterAll(async () => {
    await prisma.member.deleteMany({ where: { workspaceId: { in: [W, OTHER] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [W, OTHER] } } });
    vi.unstubAllEnvs();
  });

  const member = (role: string, uid: string | null = "user-1", ws = W, email = "pat@example.com") => prisma.member.create({ data: { workspaceId: ws, email, name: "Pat Lee", role, clerkUserId: uid } });
  const signedInAs = (role: "viewer" | "dispatcher" | "owner", uid = "user-1") => {
    state.uid = uid;
    state.cookie = cookieFor(role, uid);
  };

  test("nobody, or only half a sign-in, is signed out: no provider user, no desk cookie, a cookie made for someone else, a forged or an old one", async () => {
    const { checkAccess } = await import("@/server/tl/access");
    await member("owner");
    expect(await checkAccess("viewer")).toEqual({ ok: false, reason: "signed_out" });
    state.uid = "user-1";
    expect(await checkAccess("viewer")).toEqual({ ok: false, reason: "signed_out" }); // signed in to the provider, no desk session yet
    state.cookie = cookieFor("owner", "someone-else");
    expect(await checkAccess("viewer")).toEqual({ ok: false, reason: "signed_out" }); // a cookie is useless without its own sign-in
    state.cookie = `${cookieFor("owner").split(".")[0]}.${"0".repeat(64)}`;
    expect(await checkAccess("viewer")).toEqual({ ok: false, reason: "signed_out" });
    state.cookie = cookieFor("owner", "user-1", W, -10);
    expect(await checkAccess("viewer")).toEqual({ ok: false, reason: "signed_out" });
  });

  test("a signed-in person who is on no desk gets nothing; a member gets what their role allows, and the table's role beats the cookie's", async () => {
    const { checkAccess } = await import("@/server/tl/access");
    signedInAs("owner");
    expect(await checkAccess("viewer")).toEqual({ ok: false, reason: "no_member" });
    await member("viewer"); // the cookie says owner; the table says viewer
    expect(await checkAccess("viewer")).toMatchObject({ ok: true, identity: { role: "viewer", workspaceId: W } });
    expect(await checkAccess("dispatcher")).toEqual({ ok: false, reason: "forbidden" });
    expect(await checkAccess("owner")).toEqual({ ok: false, reason: "forbidden" });
    await prisma.member.updateMany({ where: { workspaceId: W }, data: { role: "owner" } });
    expect(await checkAccess("owner")).toMatchObject({ ok: true, identity: { role: "owner" } });
  });

  test("taking a person off the desk ends their access on the very next call, with the cookie still valid", async () => {
    const { checkAccess } = await import("@/server/tl/access");
    await member("dispatcher");
    signedInAs("dispatcher");
    expect(await checkAccess("dispatcher")).toMatchObject({ ok: true });
    await prisma.member.deleteMany({ where: { workspaceId: W } });
    expect(await checkAccess("dispatcher")).toEqual({ ok: false, reason: "no_member" });
  });

  test("a cookie for one desk is not a way into another: the member row must be on the desk the cookie names", async () => {
    const { checkAccess } = await import("@/server/tl/access");
    await member("owner", "user-1", OTHER);
    state.uid = "user-1";
    state.cookie = cookieFor("owner", "user-1", W);
    expect(await checkAccess("viewer")).toEqual({ ok: false, reason: "no_member" });
  });

  test("the workspace is the signed-in person's, and with nobody signed in nothing falls back to the demo's data", async () => {
    const { currentWorkspaceId } = await import("@/server/tl/workspace");
    const { NotSignedIn, currentActor } = await import("@/server/tl/identity");
    expect(() => currentWorkspaceId()).toThrow(NotSignedIn);
    signedInAs("dispatcher");
    expect(currentWorkspaceId()).toBe(W);
    expect(currentActor()).toBe("Pat Lee");
    state.uid = null;
    expect(currentActor()).toBe("Dispatcher");
  });

  test("an audit event is written under the signed-in person's name", async () => {
    const { recordAudit } = await import("@/server/tl/audit");
    signedInAs("dispatcher");
    await recordAudit({ entity: "settings", action: "member_added", summary: "x" });
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W } })).actor).toBe("Pat Lee");
  });

  test("a route answers 401 to nobody and 403 to a role that may not, and null to one that may", async () => {
    const { guardRoute } = await import("@/server/tl/access");
    expect((await guardRoute("viewer"))?.status).toBe(401);
    await member("viewer");
    signedInAs("viewer");
    expect(await guardRoute("viewer")).toBeNull();
    expect((await guardRoute("dispatcher"))?.status).toBe(403);
  });

  test("an action redirects the signed-out to sign-in, and refuses a role that may not with a plain message", async () => {
    const { requireMember, AccessError } = await import("@/server/tl/access");
    await expect(requireMember("viewer")).rejects.toMatchObject({ to: "/sign-in" });
    await member("viewer");
    signedInAs("viewer");
    await expect(requireMember("viewer")).resolves.toMatchObject({ role: "viewer" });
    await expect(requireMember("owner")).rejects.toBeInstanceOf(AccessError);
  });

  test("a page redirects the signed-out to sign-in and a signed-in stranger to 'no desk yet'", async () => {
    const { requirePage } = await import("@/server/tl/access");
    await expect(requirePage("viewer")).rejects.toMatchObject({ to: "/sign-in" });
    signedInAs("owner");
    await expect(requirePage("viewer")).rejects.toMatchObject({ to: "/no-workspace" });
  });

  test("first sign-in binds the provider's user to the row added for their verified email; an unverified email, or a row already taken, binds nothing", async () => {
    const { memberForSignIn } = await import("@/server/tl/members");
    await member("dispatcher", null, W, "new@example.com");
    expect(await memberForSignIn({ id: "u-9", name: "N", email: "new@example.com", emailVerified: false })).toBeNull();
    expect((await prisma.member.findFirstOrThrow({ where: { email: "new@example.com" } })).clerkUserId).toBeNull();
    const bound = await memberForSignIn({ id: "u-9", name: "N", email: "NEW@example.com", emailVerified: true });
    expect(bound).toMatchObject({ clerkUserId: "u-9", workspaceId: W });
    expect(await memberForSignIn({ id: "u-10", name: "Thief", email: "new@example.com", emailVerified: true })).toBeNull(); // the row is taken
    expect(await memberForSignIn({ id: "u-9", name: "N", email: "other@example.com", emailVerified: true })).toMatchObject({ workspaceId: W }); // found by user id from then on
    expect(await memberForSignIn({ id: "u-11", name: "Nobody", email: "nobody@example.com", emailVerified: true })).toBeNull();
  });

  test("a plan holds only so many seats; a person is on one desk; a desk keeps one owner", async () => {
    const { addMember, removeMember, setMemberRole, listMembers } = await import("@/server/tl/members");
    await prisma.workspace.update({ where: { id: OTHER }, data: { plan: "starter" } }); // one seat
    expect(await addMember({ email: "o@example.com", name: "Olive", role: "owner" }, new Date(), OTHER)).toMatchObject({ ok: true });
    expect(await addMember({ email: "two@example.com", name: "Two", role: "dispatcher" }, new Date(), OTHER)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 1 seat") });
    expect(await addMember({ email: "o@example.com", name: "Olive", role: "owner" }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("already on another desk") });
    expect(await addMember({ email: "bad", name: "x", role: "owner" }, new Date(), W)).toMatchObject({ ok: false });
    expect(await addMember({ email: "r@example.com", name: "R", role: "boss" }, new Date(), W)).toMatchObject({ ok: false });

    const [only] = await listMembers(OTHER);
    expect(await setMemberRole(only!.id, "dispatcher", new Date(), OTHER)).toMatchObject({ ok: false, error: expect.stringContaining("one owner") });
    expect(await removeMember(only!.id, new Date(), OTHER)).toMatchObject({ ok: false, error: expect.stringContaining("one owner") });

    // Growth holds 3: two owners and a dispatcher fill it; the fourth is refused, and an owner can go when another remains
    const a = await addMember({ email: "a@example.com", name: "A", role: "owner" }, new Date(), W);
    const b = await addMember({ email: "b@example.com", name: "B", role: "owner" }, new Date(), W);
    await addMember({ email: "c@example.com", name: "C", role: "dispatcher" }, new Date(), W);
    expect(await addMember({ email: "d@example.com", name: "D", role: "viewer" }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("Growth plan covers 3 seats") });
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(await setMemberRole(a.id, "viewer", new Date(), W)).toMatchObject({ ok: true });
    expect(await removeMember(b.id, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("one owner") });
    expect((await prisma.auditEvent.findMany({ where: { workspaceId: W } })).map((e) => e.action).sort()).toEqual(["member_added", "member_added", "member_added", "member_role_changed"]);
  });

  test("the cookie seam names no workspace in production, even when switched on", async () => {
    vi.stubEnv("DESK_AUTH", "off");
    vi.stubEnv("DESK_WORKSPACE_COOKIE", "on");
    vi.stubEnv("NODE_ENV", "production");
    const { currentWorkspaceId, DEMO_WORKSPACE_ID } = await import("@/server/tl/workspace");
    expect(currentWorkspaceId()).toBe(DEMO_WORKSPACE_ID);
    vi.stubEnv("DESK_AUTH", "on");
    vi.stubEnv("DESK_WORKSPACE_COOKIE", "");
    vi.stubEnv("NODE_ENV", "test");
  });

  test(`the cookie name is ${SESSION_COOKIE}`, () => {
    expect(SESSION_COOKIE).toBe("desk-session");
  });
});
