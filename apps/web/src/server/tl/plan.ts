import { prisma } from "@/lib/db";
import { centsText, isPlanKey, monthlyPriceCents, planAllows, planForTruckCount, planOf, priceText, type PlanKey } from "@/lib/plans";
import { currentWorkspaceId } from "./workspace";

/**
 * The plan side of a workspace. A workspace with no plan chosen has no limit and is priced by its fleet's size; one that has chosen a plan may hold that plan's number of trucks,
 * and adding past it (one at a time, or by importing a file) is refused with the plan named. Only trucks in service count.
 */
export async function workspacePlan(workspaceId = currentWorkspaceId()): Promise<PlanKey | null> {
  const w = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  return isPlanKey(w?.plan) ? w!.plan as PlanKey : null;
}

export const trucksInService = (workspaceId = currentWorkspaceId()) => prisma.vehicle.count({ where: { workspaceId, archivedAt: null } });

/** Whether `adding` more trucks fit this workspace's plan; the message says why not. */
export async function truckRoom(adding = 1, workspaceId = currentWorkspaceId()): Promise<{ ok: true } | { ok: false; message: string }> {
  const plan = await workspacePlan(workspaceId);
  if (!plan) return { ok: true };
  return planAllows(plan, await trucksInService(workspaceId), adding);
}

/** What Settings shows, read only: the plan (chosen, or the one the fleet's size falls in), the trucks, and the month's price with its parts. */
export async function planSummary(workspaceId = currentWorkspaceId()) {
  const [chosen, trucks] = await Promise.all([workspacePlan(workspaceId), trucksInService(workspaceId)]);
  const key = chosen ?? planForTruckCount(trucks).key;
  const p = planOf(key);
  const cents = monthlyPriceCents(key, trucks);
  return {
    key,
    chosen: chosen != null,
    label: p.label,
    trucks,
    limit: chosen ? p.max : null,
    price: priceText(key),
    monthly: centsText(cents),
    parts: p.perTruckCents > 0 ? `${centsText(p.baseCents)} + ${trucks} × ${centsText(p.perTruckCents)}` : centsText(p.baseCents)
  };
}
