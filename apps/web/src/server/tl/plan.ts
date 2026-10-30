import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { UNIT_WORD, centsText, effectivePlan, isPlanKey, limitOf, monthlyPriceCents, planAllows, planOf, priceText, type PlanKey, type UnitKind, type UnitUse } from "@/lib/plans";
import { currentWorkspaceId } from "./workspace";

/**
 * The plan side of a workspace. A workspace holds the trucks of its plan and twice as many drivers and trailers; one with no plan chosen is held to Starter, never to "no
 * limit". Adding past a limit (one at a time, by restoring one that was archived, or by importing a file) is refused with the plan named. Only units in service count: trucks
 * and trailers not archived, drivers not deactivated.
 *
 * Every path that makes a unit or brings one back calls `roomFor` INSIDE the transaction that writes it, after `lockWorkspace`, so two requests at the edge of a limit
 * cannot both pass. tests/plan-guard.test.ts fails when a new path does not.
 */
type Db = Prisma.TransactionClient | typeof prisma;

/** The plan chosen for a workspace, or null when none is (it is then held to Starter; see `effectivePlan`). */
export async function workspacePlan(workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<PlanKey | null> {
  const w = await db.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  return isPlanKey(w?.plan) ? (w!.plan as PlanKey) : null;
}

/** What is in service now, of one kind. */
export function unitsInService(kind: UnitKind, workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<number> {
  if (kind === "truck") return db.vehicle.count({ where: { workspaceId, archivedAt: null } });
  if (kind === "driver") return db.driver.count({ where: { workspaceId, active: true } });
  if (kind === "member") return db.member.count({ where: { workspaceId } });
  return db.trailer.count({ where: { workspaceId, archivedAt: null } });
}
export const trucksInService = (workspaceId = currentWorkspaceId()) => unitsInService("truck", workspaceId);

/** Take the workspace's row for the rest of the transaction, so the count that follows cannot change under it. */
export async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
  await tx.$queryRaw`select id from workspaces where id = ${workspaceId} for update`;
}

export type Room = { ok: true } | { ok: false; message: string };

/** Whether `adding` more of a kind fit this workspace's plan; the message says why not. Call it inside the writing transaction, after `lockWorkspace`. */
export async function roomFor(kind: UnitKind, adding = 1, workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<Room> {
  const plan = await workspacePlan(workspaceId, db);
  return planAllows(plan, await unitsInService(kind, workspaceId, db), adding, kind);
}

/** What Settings shows, read only: the plan, what is used of each limit, and the month's price with its parts. */
export async function planSummary(workspaceId = currentWorkspaceId()) {
  const [chosen, trucks, drivers, trailers, members] = await Promise.all([workspacePlan(workspaceId), unitsInService("truck", workspaceId), unitsInService("driver", workspaceId), unitsInService("trailer", workspaceId), unitsInService("member", workspaceId)]);
  const key = effectivePlan(chosen);
  const p = planOf(key);
  const cents = monthlyPriceCents(key, trucks);
  const use = (kind: UnitKind, used: number): UnitUse => {
    const limit = limitOf(key, kind);
    return { kind, word: UNIT_WORD[kind][1], used, limit, full: limit != null && used >= limit };
  };
  return {
    key,
    chosen: chosen != null,
    label: p.label,
    trucks,
    limit: limitOf(key, "truck"),
    units: [use("truck", trucks), use("driver", drivers), use("trailer", trailers), use("member", members)],
    price: priceText(key),
    monthly: centsText(cents),
    parts: p.perTruckCents > 0 ? `${centsText(p.baseCents)} + ${trucks} × ${centsText(p.perTruckCents)}` : centsText(p.baseCents)
  };
}

/** For an Add button: how many of a kind are in use against the limit, so it can say "2 of 3" and stop at the limit. */
export async function unitUse(kind: UnitKind, workspaceId = currentWorkspaceId()): Promise<UnitUse> {
  const [chosen, used] = await Promise.all([workspacePlan(workspaceId), unitsInService(kind, workspaceId)]);
  const limit = limitOf(effectivePlan(chosen), kind);
  return { kind, word: UNIT_WORD[kind][1], used, limit, full: limit != null && used >= limit };
}
