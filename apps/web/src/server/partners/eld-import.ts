import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { allocateDriverCodes } from "@/server/tl/driver-codes";
import { lockWorkspace, roomFor, unitUse } from "@/server/tl/plan";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, providerName } from "./call";
import { syncEld } from "./eld";

/**
 * One-click onboarding: when a fleet's ELD is connected, read everything the company has (its vehicles and the people who drive them) and add what the desk does not have yet as trucks and
 * drivers, then read where they are so the radar lights up at once. Nothing the desk already has is touched, and a person's typed figure is never overwritten: a truck or driver is matched by
 * the ELD's id, else its VIN, else its name, and a match is left alone. The plan's limits hold (it imports as many as fit and says how many it left out). Idempotent: a second run adds nothing.
 */
export type ImportEldResult =
  | { ok: true; provider: string; trucks: number; drivers: number; skippedTrucks: number; skippedDrivers: number; onMap: number }
  | { ok: false; error: string; code?: string };

const room = (u: { limit: number | null; used: number }, want: number) => (u.limit == null ? want : Math.max(0, Math.min(want, u.limit - u.used)));

export async function importEldFleet(now = new Date(), workspaceId = currentWorkspaceId()): Promise<ImportEldResult> {
  const { provider, result } = await callPartner("eld", null, { vehicles: [], discover: true }, workspaceId);
  if (!result.ok) return { ok: false, error: result.message ?? "The ELD could not be reached.", code: result.code };
  const roster = result.data.roster;
  if (!roster) return { ok: false, error: `${providerName(provider)} did not list its fleet.` };

  const [trucks, people] = await Promise.all([
    prisma.vehicle.findMany({ where: { workspaceId }, select: { id: true, name: true, eldVehicleId: true, vin: true } }),
    prisma.driver.findMany({ where: { workspaceId }, select: { id: true, name: true, eldDriverId: true } })
  ]);
  const haveTruck = (v: (typeof roster.vehicles)[number]) => trucks.some((t) => (t.eldVehicleId != null && t.eldVehicleId === v.eldVehicleId) || (t.vin != null && v.vin != null && t.vin.toLowerCase() === v.vin.toLowerCase()) || (t.name != null && t.name.trim().toLowerCase() === v.number.trim().toLowerCase()));
  const haveDriver = (d: (typeof roster.drivers)[number]) => people.some((p) => (p.eldDriverId != null && p.eldDriverId === d.eldDriverId) || p.name.trim().toLowerCase() === d.name.trim().toLowerCase());
  const newTrucks = roster.vehicles.filter((v) => !haveTruck(v));
  const newDrivers = roster.drivers.filter((d) => !haveDriver(d));

  const name = providerName(provider);
  const counts = await prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const [truckUse, driverUse] = await Promise.all([unitUse("truck", workspaceId), unitUse("driver", workspaceId)]);
      // As many as the plan has room for, then the authoritative check for exactly that many, under the lock, before anything is created.
      let takeTrucks = newTrucks.slice(0, room(truckUse, newTrucks.length));
      if (takeTrucks.length > 0 && !(await roomFor("truck", takeTrucks.length, workspaceId, tx)).ok) takeTrucks = [];
      let takeDrivers = newDrivers.slice(0, room(driverUse, newDrivers.length));
      if (takeDrivers.length > 0 && !(await roomFor("driver", takeDrivers.length, workspaceId, tx)).ok) takeDrivers = [];

      const made = new Map<string, string>(); // the company's vehicle id -> the desk truck
      for (const v of takeTrucks) {
        const t = await tx.vehicle.create({ data: { workspaceId, name: v.number, make: v.make, model: v.model, year: v.year, vin: v.vin, eldProvider: provider, eldVehicleId: v.eldVehicleId } });
        made.set(v.eldVehicleId, t.id);
      }
      const deskTruckOf = (eldId: string | null | undefined) => (eldId == null ? null : (made.get(eldId) ?? trucks.find((t) => t.eldVehicleId === eldId)?.id ?? null));

      const codes = await allocateDriverCodes(tx, workspaceId, takeDrivers.map((d) => d.name));
      for (const [i, d] of takeDrivers.entries()) {
        await tx.driver.create({
          data: { workspaceId, name: d.name, code: codes[i]!, licenseNumber: d.licenseNumber, eldDriverId: d.eldDriverId, assignedVehicleId: deskTruckOf(d.eldVehicleId), hosDriveMinutes: d.driveMinutes, hosShiftMinutes: d.shiftMinutes, hosCycleMinutes: d.cycleMinutes, hosSyncedAt: now }
        });
      }
      if (takeTrucks.length > 0 || takeDrivers.length > 0) {
        await recordAudit(
          {
            entity: "fleet",
            action: "eld_fleet_imported",
            summary: `Imported ${takeTrucks.length} ${takeTrucks.length === 1 ? "truck" : "trucks"} and ${takeDrivers.length} ${takeDrivers.length === 1 ? "driver" : "drivers"} from ${name}`,
            before: null,
            after: { Trucks: String(takeTrucks.length), Drivers: String(takeDrivers.length), "Left out (plan limit)": String(newTrucks.length - takeTrucks.length + (newDrivers.length - takeDrivers.length)) },
            at: now,
            workspaceId
          },
          tx
        );
      }
      return { trucks: takeTrucks.length, drivers: takeDrivers.length, skippedTrucks: newTrucks.length - takeTrucks.length, skippedDrivers: newDrivers.length - takeDrivers.length };
    },
    { timeout: 60_000 }
  );

  // Where they are, at once, so the radar has something to show the moment the key is entered.
  const read = await syncEld(now, workspaceId);
  const onMap = read.ok ? await prisma.vehicle.count({ where: { workspaceId, archivedAt: null, eldProvider: provider, lastLat: { not: null } } }) : 0;
  return { ok: true, provider, ...counts, onMap };
}
