import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner } from "./call";

/** IFTA: a quarter's fuel-tax miles and gallons by state, worked out by the mileage company. No screen offers it yet; this is the seam. */
export type IftaResult = { ok: true; jurisdictions: Array<{ state: string; miles: number; gallons: number }> } | { ok: false; error: string; code?: string };

export async function calculateIfta(quarter: string, workspaceId = currentWorkspaceId()): Promise<IftaResult> {
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) return { ok: false, error: "A quarter, like 2026-Q3.", code: "bad_request" };
  const vehicles = await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true }, take: 2000 });
  const { result } = await callPartner("ifta", null, { quarter, vehicles }, workspaceId);
  return result.ok ? { ok: true, jurisdictions: result.data.jurisdictions } : { ok: false, error: result.message ?? "The mileage company could not be reached.", code: result.code };
}
