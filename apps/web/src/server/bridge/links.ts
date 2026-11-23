import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { decideLink, deskOrgIdFor, formatInviteCode, hashInviteCode, inviteExpiresAt, isLinkRole, linkStateOf, newInviteCode, newLinkRow, pullOrder, switchesFor, type LinkRole, type LinkState, type LinkSwitches } from "@/lib/driver-link";
import { BridgeTransportError, type BridgeTransport } from "./transport";

/**
 * The driver link's identity half, with the database and the bridge (Phase 2 step 1; the pure rules are src/lib/driver-link.ts). A dispatcher makes a code for one driver; the code is
 * shown once and only its hash is kept. The phone claims it on the bridge; `pullDriverLinks` (run by the bridge cron, or by the driver's page on demand) reads the claim and fills
 * `Driver.phoneUserId` with the phone's Clerk user id, and `Workspace.bridgeOrgId` with the fleet's tenant key the first time a driver links. Ending a link clears the phone account.
 */

export type IssueResult = { ok: true; code: string; expiresAt: Date } | { ok: false; error: string };

const NOT_ON = "The driver link is not switched on for this server yet.";
const UNREACHABLE = "The driver link could not be reached. Try again in a minute.";

/** Make a new code for this driver (any earlier unclaimed code stops working). Needs the bridge: the code is useless until the phone can claim it there. */
export async function issueDriverInvite(transport: BridgeTransport | null, i: { driverId: string; role: string; switches?: Partial<LinkSwitches>; now?: Date; workspaceId?: string; actor?: string }): Promise<IssueResult> {
  if (!transport) return { ok: false, error: NOT_ON };
  if (!isLinkRole(i.role)) return { ok: false, error: "Pick how this driver works for you." };
  const workspaceId = i.workspaceId ?? currentWorkspaceId();
  const now = i.now ?? new Date();
  const [ws, driver] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, bridgeOrgId: true } }),
    prisma.driver.findFirst({ where: { id: i.driverId, workspaceId }, select: { id: true, name: true, active: true, phoneUserId: true } })
  ]);
  if (!ws || !driver) return { ok: false, error: "That driver is not in this fleet." };
  if (!driver.active) return { ok: false, error: "This driver is archived. Restore them first." };
  if (driver.phoneUserId) return { ok: false, error: "This driver's phone is already linked. End that link first." };
  const orgId = deskOrgIdFor(ws);
  const code = newInviteCode();
  const codeHash = hashInviteCode(code);
  const expiresAt = inviteExpiresAt(now);
  const role = i.role as LinkRole;
  // A contractor's switches as set; an employee's none (sync plan Step 3).
  const switches = switchesFor(role, i.switches);
  try {
    await transport.revokeUnclaimedLinks(orgId, driver.id, now);
    const row = await transport.insertLink(newLinkRow({ orgId, driverId: driver.id, carrierName: ws.name, role, codeHash, expiresAt, switches }));
    await prisma.$transaction(async (tx) => {
      await tx.driverLinkInvite.updateMany({ where: { workspaceId, driverId: driver.id, claimedAt: null, revokedAt: null }, data: { revokedAt: now, endedBy: "desk" } });
      await tx.driverLinkInvite.create({ data: { workspaceId, driverId: driver.id, codeHash, driverRole: role, ...switches, expiresAt, bridgeLinkId: row.id, createdBy: i.actor ?? null } });
      await recordAudit({ entity: "fleet", entityId: driver.id, action: "driver_link_code_made", summary: `Phone link code made for ${driver.name}`, at: now, workspaceId, ...(i.actor ? { actor: i.actor } : {}) }, tx);
    });
  } catch (e) {
    if (e instanceof BridgeTransportError) return { ok: false, error: UNREACHABLE };
    throw e;
  }
  return { ok: true, code: formatInviteCode(code), expiresAt };
}

/** End this driver's link from the desk: the bridge row is withdrawn, the phone account cleared. The phone unlocks on its next check. */
export async function endDriverLinkFromDesk(transport: BridgeTransport | null, i: { driverId: string; now?: Date; workspaceId?: string; actor?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!transport) return { ok: false, error: NOT_ON };
  const workspaceId = i.workspaceId ?? currentWorkspaceId();
  const now = i.now ?? new Date();
  const [ws, driver] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, bridgeOrgId: true } }),
    prisma.driver.findFirst({ where: { id: i.driverId, workspaceId }, select: { id: true, name: true, phoneUserId: true } })
  ]);
  if (!ws || !driver) return { ok: false, error: "That driver is not in this fleet." };
  try {
    await transport.endLink(deskOrgIdFor(ws), driver.id, now);
  } catch (e) {
    if (e instanceof BridgeTransportError) return { ok: false, error: UNREACHABLE };
    throw e;
  }
  await prisma.$transaction(async (tx) => {
    await tx.driverLinkInvite.updateMany({ where: { workspaceId, driverId: driver.id, revokedAt: null }, data: { revokedAt: now, endedBy: "desk" } });
    if (driver.phoneUserId) {
      await tx.driver.update({ where: { id: driver.id }, data: { phoneUserId: null } });
      await recordAudit({ entity: "fleet", entityId: driver.id, action: "driver_unlinked", summary: `${driver.name}'s phone unlinked by the desk`, at: now, workspaceId, ...(i.actor ? { actor: i.actor } : {}) }, tx);
    }
  });
  return { ok: true };
}

export type LinkPullResult = { read: number; linked: number; unlinked: number; flagged: number };

/**
 * Read this fleet's claimed links and bring the drivers in line: a claim fills the phone account, an ended link clears it, a phone account another driver holds is flagged. Idempotent:
 * a row already reflected changes nothing. The fleet's tenant key is written the first time a driver links, which is what switches the fleet's loads onto the bridge.
 */
export async function pullDriverLinks(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date } = {}): Promise<LinkPullResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const out: LinkPullResult = { read: 0, linked: 0, unlinked: 0, flagged: 0 };
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, bridgeOrgId: true } });
  if (!ws) return out;
  const orgId = deskOrgIdFor(ws);
  const rows = pullOrder(await transport.claimedLinks(orgId, 500));
  out.read = rows.length;
  if (rows.length === 0) return out;
  const drivers = await prisma.driver.findMany({ where: { workspaceId }, select: { id: true, name: true, phoneUserId: true } });
  const byId = new Map(drivers.map((d) => [d.id, d] as const));
  const holder = new Map(drivers.filter((d) => d.phoneUserId).map((d) => [d.phoneUserId!, d.id] as const));
  for (const row of rows) {
    const decision = decideLink(row, byId, (p) => holder.get(p) ?? null);
    if (decision.kind === "ignore") continue;
    const d = byId.get(decision.driverId)!;
    if (decision.kind === "flag") {
      // Once per claim: the cron pulls every minute, and a flag nobody has dealt with must not fill the audit trail. The invite remembers which phone it was flagged for;
      // a different phone claiming later (a new code) is a new flag.
      const claimant = row.claimed_by!;
      const marked = await prisma.driverLinkInvite.updateMany({ where: { workspaceId, bridgeLinkId: row.id, OR: [{ flaggedFor: null }, { flaggedFor: { not: claimant } }] }, data: { flaggedFor: claimant } });
      // Already flagged for this phone (or no invite of this desk behind the row): nothing new to record; the link is left alone either way.
      if (marked.count === 0) continue;
      await recordAudit({ entity: "fleet", entityId: d.id, action: "driver_link_flag", summary: `${d.name}: ${decision.why}`, at: now, workspaceId, actor: "Driver's phone" });
      out.flagged += 1;
      continue;
    }
    if (decision.kind === "link") {
      await prisma.$transaction(async (tx) => {
        await tx.driver.update({ where: { id: d.id }, data: { phoneUserId: decision.phoneUserId } });
        if (!ws.bridgeOrgId) await tx.workspace.update({ where: { id: ws.id }, data: { bridgeOrgId: orgId } });
        await tx.driverLinkInvite.updateMany({ where: { workspaceId, bridgeLinkId: row.id }, data: { claimedBy: decision.phoneUserId, claimedAt: decision.claimedAt } });
        await recordAudit({ entity: "fleet", entityId: d.id, action: "driver_linked", summary: `${d.name}'s phone linked`, at: now, workspaceId, actor: "Driver's phone" }, tx);
      });
      ws.bridgeOrgId = orgId;
      if (d.phoneUserId) holder.delete(d.phoneUserId);
      d.phoneUserId = decision.phoneUserId;
      holder.set(decision.phoneUserId, d.id);
      out.linked += 1;
      continue;
    }
    // unlink
    await prisma.$transaction(async (tx) => {
      await tx.driver.update({ where: { id: d.id }, data: { phoneUserId: null } });
      await tx.driverLinkInvite.updateMany({ where: { workspaceId, bridgeLinkId: row.id, revokedAt: null }, data: { revokedAt: now, endedBy: decision.endedBy } });
      const summary = decision.endedBy === "driver" ? `${d.name} ended the link from their phone` : decision.endedBy === "replaced" ? `${d.name}'s phone moved to a newer code from this fleet` : `${d.name}'s phone unlinked`;
      await recordAudit({ entity: "fleet", entityId: d.id, action: "driver_unlinked", summary, at: now, workspaceId, actor: decision.endedBy === "desk" ? undefined : "Driver's phone" }, tx);
    });
    holder.delete(decision.phoneUserId);
    d.phoneUserId = null;
    out.unlinked += 1;
  }
  return out;
}

/** What the driver's page shows about the link. */
export async function driverLinkView(driverId: string, opts: { workspaceId?: string; now?: Date } = {}): Promise<{ state: LinkState; role: LinkRole | null; switches: LinkSwitches }> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const [driver, latest] = await Promise.all([
    prisma.driver.findFirst({ where: { id: driverId, workspaceId }, select: { phoneUserId: true } }),
    prisma.driverLinkInvite.findFirst({ where: { workspaceId, driverId }, orderBy: { createdAt: "desc" }, select: { expiresAt: true, claimedAt: true, revokedAt: true, driverRole: true, forcedDispatch: true, underAuthority: true, sponsored: true } })
  ]);
  const state = linkStateOf({ phoneUserId: driver?.phoneUserId ?? null, latest: latest ?? null, now: opts.now ?? new Date() });
  const role = latest && isLinkRole(latest.driverRole) ? latest.driverRole : null;
  return { state, role, switches: switchesFor(role ?? "company", latest) };
}

/** Workspaces the bridge cron should pull links for: every fleet already linked, plus any with a code still waiting to be claimed. */
export async function fleetsWithLinksToPull(now: Date = new Date()): Promise<string[]> {
  const [bridged, waiting] = await Promise.all([
    prisma.workspace.findMany({ where: { bridgeOrgId: { not: null } }, select: { id: true } }),
    prisma.driverLinkInvite.findMany({ where: { claimedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { workspaceId: true }, distinct: ["workspaceId"] })
  ]);
  return [...new Set([...bridged.map((w) => w.id), ...waiting.map((w) => w.workspaceId)])];
}
