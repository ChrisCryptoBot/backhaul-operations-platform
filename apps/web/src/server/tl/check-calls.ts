import { prisma } from "@/lib/db";
import { callStatusOf } from "@/lib/asset-history";
import { parseCentralLocal } from "@/lib/zoned";
import { recordAudit } from "./audit";
import { currentActor } from "./identity";
import { workspaceTimezone } from "./zone";
import { currentWorkspaceId } from "./workspace";

/**
 * Check calls on a truck or a trailer: a dispatcher rings the driver and writes down where they are and when they expect to arrive, so that when a load is late or a detention claim is disputed the
 * record of what was said, and when, is there. The times a person types are on the carrier's clock (the workspace's zone). A call can be back-dated (it was made an hour ago) but not dated in the
 * future, and one made by mistake can be removed; both are written to the audit trail.
 */
export type CheckCallInput = {
  unit: { kind: "truck" | "trailer"; id: string };
  /** "2026-11-05T14:30" on the carrier's clock; blank means now. */
  at?: string | null;
  place?: string | null;
  etaAt?: string | null;
  status?: string | null;
  note?: string | null;
  spokeWith?: string | null;
  loadId?: string | null;
};
export type CheckCallResult = { ok: true; id: string } | { ok: false; error: string };

export const MAX_PLACE = 200;
export const MAX_NOTE = 1000;
export const MAX_SPOKE = 100;
/** A call can be back-dated this far. */
export const MAX_BACKDATE_DAYS = 366;
/** The clock on a screen can be a little ahead of the server's. */
const FUTURE_SLACK_MS = 5 * 60_000;

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : null;
};
const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

export async function logCheckCall(input: CheckCallInput, now = new Date(), workspaceId = currentWorkspaceId()): Promise<CheckCallResult> {
  const kind = input?.unit?.kind;
  const unitId = String(input?.unit?.id ?? "");
  if ((kind !== "truck" && kind !== "trailer") || !unitId) return { ok: false, error: "Pick the truck or trailer the call is about." };
  const unit = kind === "truck" ? await prisma.vehicle.findFirst({ where: { id: unitId, workspaceId }, select: { id: true, name: true } }) : await prisma.trailer.findFirst({ where: { id: unitId, workspaceId }, select: { id: true, number: true } });
  if (!unit) return { ok: false, error: "That unit is not in this fleet." };
  const label = kind === "truck" ? ((unit as { name: string | null }).name ?? "the truck") : (unit as { number: string }).number;

  const tz = await workspaceTimezone(workspaceId);
  const at = blank(input.at) ? now.getTime() : parseCentralLocal(String(input.at), tz);
  if (at == null) return { ok: false, error: "When was the call? Pick a date and time." };
  if (at > now.getTime() + FUTURE_SLACK_MS) return { ok: false, error: "A call cannot be dated in the future." };
  if (at < now.getTime() - MAX_BACKDATE_DAYS * 86_400_000) return { ok: false, error: `A call cannot be dated more than ${MAX_BACKDATE_DAYS} days back.` };
  const eta = blank(input.etaAt) ? null : parseCentralLocal(String(input.etaAt), tz);
  if (!blank(input.etaAt) && eta == null) return { ok: false, error: "The arrival time is not a date and time." };

  const place = clean(input.place, MAX_PLACE);
  const note = clean(input.note, MAX_NOTE);
  const spokeWith = clean(input.spokeWith, MAX_SPOKE);
  const status = callStatusOf(input.status);
  if (!blank(input.status) && status == null) return { ok: false, error: "Pick on time, running late or issue, or leave it blank." };
  if (!place && eta == null && !status && !note) return { ok: false, error: "Say something about the call: where they are, when they will arrive, how it is going, or a note." };

  let loadNumber: string | null = null;
  const loadId = blank(input.loadId) ? null : String(input.loadId);
  if (loadId) {
    const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...(kind === "truck" ? { vehicleId: unitId } : { trailerId: unitId }) }, select: { loadNumber: true } });
    if (!load) return { ok: false, error: `That load is not on ${label}.` };
    loadNumber = load.loadNumber;
  }

  const said = [place, status ? status.replace("_", " ") : null, note].filter(Boolean).join(" · ");
  const row = await prisma.$transaction(async (tx) => {
    const made = await tx.checkCall.create({
      data: { workspaceId, vehicleId: kind === "truck" ? unitId : null, trailerId: kind === "trailer" ? unitId : null, loadId, at: new Date(at), place, etaAt: eta != null ? new Date(eta) : null, status, note, spokeWith, loggedBy: currentActor() },
      select: { id: true }
    });
    await recordAudit({ workspaceId, entity: kind === "truck" ? "fleet" : "trailer", entityId: unitId, loadId: loadId ?? undefined, loadNumber: loadNumber ?? undefined, action: "check_call", summary: `Check call on ${label}${said ? `: ${said.slice(0, 160)}` : ""}`, before: null, after: { Place: place, Status: status, Note: note } }, tx);
    return made;
  });
  return { ok: true, id: row.id };
}

/** Remove a call that was logged by mistake. The audit trail keeps what it said. */
export async function removeCheckCall(id: string, workspaceId = currentWorkspaceId()): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = await prisma.checkCall.findFirst({ where: { id: String(id), workspaceId }, include: { vehicle: { select: { name: true } }, trailer: { select: { number: true } }, load: { select: { loadNumber: true } } } });
  if (!c) return { ok: false, error: "That check call is already gone." };
  const label = c.vehicle?.name ?? c.trailer?.number ?? "a unit";
  await prisma.$transaction(async (tx) => {
    await tx.checkCall.delete({ where: { id: c.id } });
    await recordAudit({ workspaceId, entity: c.vehicleId ? "fleet" : "trailer", entityId: c.vehicleId ?? c.trailerId ?? undefined, loadId: c.loadId ?? undefined, loadNumber: c.load?.loadNumber ?? undefined, action: "check_call_removed", summary: `Check call on ${label} removed`, before: { Place: c.place, Status: c.status, Note: c.note, Spoke_with: c.spokeWith, Logged_by: c.loggedBy }, after: null }, tx);
  });
  return { ok: true };
}
