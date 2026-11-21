import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { driverLinkView, endDriverLinkFromDesk, fleetsWithLinksToPull, issueDriverInvite, pullDriverLinks } from "@/server/bridge/links";
import { memoryTransport } from "@/server/bridge/transport";
import { hashInviteCode } from "@/lib/driver-link";

/**
 * Phase 2 step 1, the identity link on the demo database, with the in-memory bridge table standing in for Supabase (no network):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/driver-link.integration.test.ts
 * It writes to that database and puts everything back, so it is skipped unless RUN_DB_INTEGRATION=true.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const PHONE = "user_phone_link_test";

describe.skipIf(!run)("the driver link, identity half", () => {
  const ws = currentWorkspaceId();
  let driverId = "";
  let otherId = "";
  let saved: { bridgeOrgId: string | null; phone: string | null; otherPhone: string | null } = { bridgeOrgId: null, phone: null, otherPhone: null };
  const startedAt = new Date();

  beforeAll(async () => {
    const w = await prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { bridgeOrgId: true } });
    const [d, o] = await prisma.driver.findMany({ where: { workspaceId: ws, active: true }, orderBy: { name: "asc" }, take: 2, select: { id: true, phoneUserId: true } });
    driverId = d!.id;
    otherId = o!.id;
    saved = { bridgeOrgId: w.bridgeOrgId, phone: d!.phoneUserId, otherPhone: o!.phoneUserId };
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: null } });
    await prisma.driver.updateMany({ where: { id: { in: [driverId, otherId] } }, data: { phoneUserId: null } });
  });

  afterAll(async () => {
    await prisma.driverLinkInvite.deleteMany({ where: { workspaceId: ws, createdAt: { gte: startedAt } } });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: ws, createdAt: { gte: startedAt }, action: { in: ["driver_link_code_made", "driver_linked", "driver_unlinked", "driver_link_flag"] } } });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: saved.phone } });
    await prisma.driver.update({ where: { id: otherId }, data: { phoneUserId: saved.otherPhone } });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: saved.bridgeOrgId } });
  });

  test("with no bridge keys the desk says the link is not on, and stores nothing", async () => {
    const out = await issueDriverInvite(null, { driverId, role: "company" });
    expect(out).toEqual({ ok: false, error: "The driver link is not switched on for this server yet." });
  });

  test("a code is made, kept only as its hash, claimed on the phone, and the pull links the driver and switches the fleet on", async () => {
    const t = memoryTransport();
    const now = new Date();
    const out = await issueDriverInvite(t, { driverId, role: "owner_op_leased", now });
    if (!out.ok) throw new Error(out.error);
    expect(out.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const stored = await prisma.driverLinkInvite.findFirstOrThrow({ where: { workspaceId: ws, driverId }, orderBy: { createdAt: "desc" } });
    expect(stored.codeHash).toBe(hashInviteCode(out.code));
    expect(JSON.stringify(stored)).not.toContain(out.code.replace("-", ""));
    expect(t.links[0]).toMatchObject({ org_id: `desk_${ws}`, desk_driver_id: driverId, driver_role: "owner_op_leased", code_hash: stored.codeHash });
    expect((await driverLinkView(driverId)).state.kind).toBe("pending");
    expect(await fleetsWithLinksToPull()).toContain(ws);

    expect(t.claim(hashInviteCode(out.code.toLowerCase()), PHONE, now)).toBe("ok");
    const got = await pullDriverLinks(t, { now });
    expect(got).toMatchObject({ read: 1, linked: 1 });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).phoneUserId).toBe(PHONE);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).bridgeOrgId).toBe(`desk_${ws}`);
    expect((await driverLinkView(driverId)).state.kind).toBe("linked");
    // Idempotent: the same pull again changes nothing.
    expect(await pullDriverLinks(t, { now })).toMatchObject({ linked: 0, unlinked: 0 });
  });

  test("a new code replaces an unclaimed one, and a linked driver cannot get another until the link ends", async () => {
    const t = memoryTransport();
    expect(await issueDriverInvite(t, { driverId, role: "company" })).toEqual({ ok: false, error: "This driver's phone is already linked. End that link first." });
    const a = await issueDriverInvite(t, { driverId: otherId, role: "company" });
    const b = await issueDriverInvite(t, { driverId: otherId, role: "company" });
    if (!a.ok || !b.ok) throw new Error("codes");
    expect(t.claim(hashInviteCode(a.code), "user_x", new Date())).toBe("link_invalid");
    // The same phone cannot sit on two drivers: claiming the other driver's code with the first driver's phone is flagged, never moved.
    expect(t.claim(hashInviteCode(b.code), PHONE, new Date())).toBe("ok");
    const got = await pullDriverLinks(t);
    expect(got.flagged).toBe(1);
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: otherId } })).phoneUserId).toBeNull();
    // The cron pulls every minute: the same flagged claim is recorded once, not again on each pull.
    expect((await pullDriverLinks(t)).flagged).toBe(0);
    expect((await pullDriverLinks(t)).flagged).toBe(0);
    const flags = await prisma.auditEvent.count({ where: { workspaceId: ws, entityId: otherId, action: "driver_link_flag", createdAt: { gte: startedAt } } });
    expect(flags).toBe(1);
  });

  test("ending the link from the desk clears the phone account; ended by the driver, the pull clears it", async () => {
    const t = memoryTransport();
    expect(await endDriverLinkFromDesk(t, { driverId })).toEqual({ ok: true });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).phoneUserId).toBeNull();

    const c = await issueDriverInvite(t, { driverId, role: "company" });
    if (!c.ok) throw new Error(c.error);
    t.claim(hashInviteCode(c.code), PHONE, new Date());
    await pullDriverLinks(t);
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).phoneUserId).toBe(PHONE);
    // The driver disconnects on the phone (bridge.end_driver_link).
    Object.assign(t.links.find((l) => l.claimed_by === PHONE && !l.revoked_at)!, { revoked_at: new Date().toISOString(), ended_by: "driver" });
    expect(await pullDriverLinks(t)).toMatchObject({ unlinked: 1 });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).phoneUserId).toBeNull();
  });
});
