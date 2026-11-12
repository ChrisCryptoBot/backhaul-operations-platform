import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseIntake, validateIntake, type LeakIntake } from "@/lib/leak-intake";
import { recordAudit } from "./audit";
import { currentWorkspaceId } from "./workspace";

/**
 * The Leak Read intake, stored as one document on the workspace (lib/leak-intake.ts says what is in it and which figure prices which load). Saved with one audit event that shows what changed; saving what
 * is already stored writes nothing. Read back through `parseIntake`, so a figure that is not sound can never price a load.
 */
export async function getLeakIntake(workspaceId = currentWorkspaceId()): Promise<LeakIntake> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { leakIntake: true } });
  return parseIntake(ws?.leakIntake);
}

const usd = (n: number | null) => (n == null ? "Not given" : `$${n.toFixed(2)}`);
const snapshot = (i: LeakIntake) => ({
  "Cost a mile (fleet)": i.costPerMile == null ? "Not given" : `$${i.costPerMile.toFixed(4).replace(/0{1,2}$/, "")}`,
  "Detention rate an hour (fleet)": usd(i.detentionRate),
  "Free time at a stop (fleet)": i.freeMinutes == null ? "Not given" : `${i.freeMinutes} minutes`,
  "Trucks with their own cost a mile": String(i.trucks.length),
  "Customers with their own terms": String(i.customers.length)
});

export type IntakeSave = { ok: true; changed: boolean } | { ok: false; errors: Record<string, string> };

export async function saveLeakIntake(input: unknown, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IntakeSave> {
  const check = validateIntake(input);
  if (!check.ok) return check;
  const before = await getLeakIntake(workspaceId);
  if (JSON.stringify(before) === JSON.stringify(check.intake)) return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { leakIntake: check.intake as unknown as Prisma.InputJsonObject } });
    await recordAudit(
      {
        entity: "settings",
        action: "leak_intake_saved",
        summary: `Leak Read intake saved (${check.intake.trucks.length} ${check.intake.trucks.length === 1 ? "truck" : "trucks"}, ${check.intake.customers.length} ${check.intake.customers.length === 1 ? "customer" : "customers"} with their own figures)`,
        before: snapshot(before),
        after: snapshot(check.intake),
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true, changed: true };
}

/** The trucks and customers on the imported loads, so the intake form can offer each one a row. */
export type IntakeRoster = {
  importedLoads: number;
  /** Imported loads whose file carried stop times (a wait at a stop), so detention can be checked on them. */
  withStopTimes: number;
  trucks: Array<{ name: string; loads: number }>;
  customers: Array<{ name: string; loads: number }>;
  /** The trucks on the desk that no imported load names, which the form leaves out. */
  deskTrucks: string[];
};

const ROSTER_LIMIT = 300;

export async function getIntakeRoster(workspaceId = currentWorkspaceId()): Promise<IntakeRoster> {
  const [totals, trucks, customers, deskTrucks] = await Promise.all([
    prisma.$queryRaw<Array<{ n: number; t: number }>>`
      select count(*)::int as n, (count(*) filter (where exists (select 1 from stops s where s.load_id = l.id and s.wait_minutes is not null)))::int as t
      from loads l where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.channel like 'import:%'`,
    prisma.$queryRaw<Array<{ name: string; loads: number }>>`
      select v.name as name, count(*)::int as loads from loads l join vehicles v on v.id = l.vehicle_id
      where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.channel like 'import:%' and v.name is not null
      group by v.name order by count(*) desc, v.name limit ${ROSTER_LIMIT}`,
    prisma.$queryRaw<Array<{ name: string; loads: number }>>`
      select l.broker_name as name, count(*)::int as loads from loads l
      where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.channel like 'import:%' and l.broker_name is not null and l.broker_name <> ''
      group by l.broker_name order by count(*) desc, l.broker_name limit ${ROSTER_LIMIT}`,
    prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null, name: { not: null } }, select: { name: true }, orderBy: { name: "asc" }, take: ROSTER_LIMIT })
  ]);
  const named = new Set(trucks.map((t) => t.name.toLowerCase()));
  return {
    importedLoads: totals[0]?.n ?? 0,
    withStopTimes: totals[0]?.t ?? 0,
    trucks,
    customers,
    deskTrucks: deskTrucks.flatMap((v) => (v.name && !named.has(v.name.toLowerCase()) ? [v.name] : []))
  };
}
