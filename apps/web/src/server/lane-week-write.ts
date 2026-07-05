import { Prisma } from "@prisma/client";
import { runInRegionScope } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { decodeLaneWeekMetadata, encodeLaneWeekMetadata } from "@/server/lane-week-metadata";

/**
 * Per-lane weekly notes and manual market/target rates, stored in
 * WeekSnapshot.laneIssueNotes. Extracted so both the KPI API routes and the
 * copilot tools share one write path. RBAC (KPI_DASHBOARD:WRITE) is enforced by
 * the caller before these run.
 */

const EMPTY_SNAPSHOT_DEFAULTS = {
  loadCount: 0,
  lineHaulRevenue: new Prisma.Decimal(0),
  fuelSurchargeAmount: new Prisma.Decimal(0),
  totalLoadedMiles: new Prisma.Decimal(0),
  totalPickupDeadhead: new Prisma.Decimal(0),
  totalDeliveryDeadhead: new Prisma.Decimal(0),
  totalEmptyMiles: new Prisma.Decimal(0),
  totalTripMiles: new Prisma.Decimal(0),
  totalAllInRevenue: new Prisma.Decimal(0),
  totalTonuAmount: new Prisma.Decimal(0),
  mileMaxMissingInbound: true
} as const;

export async function setLaneNote(input: {
  regionId: string;
  weekIso: string;
  lane: string;
  note: string;
  actorId: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const existing = await tx.weekSnapshot.findUnique({
      where: { regionId_weekIso: { regionId: input.regionId, weekIso: input.weekIso } }
    });
    const current = decodeLaneWeekMetadata(existing?.laneIssueNotes);
    const notes = { ...current.notes };
    if (input.note.trim()) {
      notes[input.lane] = input.note.trim();
    } else {
      delete notes[input.lane];
    }
    await tx.weekSnapshot.upsert({
      where: { regionId_weekIso: { regionId: input.regionId, weekIso: input.weekIso } },
      update: { laneIssueNotes: encodeLaneWeekMetadata({ ...current, notes }) },
      create: {
        regionId: input.regionId,
        weekIso: input.weekIso,
        laneIssueNotes: encodeLaneWeekMetadata({ notes }),
        ...EMPTY_SNAPSHOT_DEFAULTS
      }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "WeekSnapshot",
        entityId: `${input.regionId}:${input.weekIso}`,
        action: "UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: `Lane note updated for ${input.lane}`,
        afterValue: { lane: input.lane, note: input.note }
      })
    });
  });
}

export async function setLaneWeeklyTarget(input: {
  regionId: string;
  weekIso: string;
  lane: string;
  /** Normalized decimal string; empty clears the override. Caller validates positivity. */
  targetRate: string;
  actorId: string;
}): Promise<void> {
  const normalized = input.targetRate.trim();
  await runInRegionScope(input.regionId, async (tx) => {
    const existing = await tx.weekSnapshot.findUnique({
      where: { regionId_weekIso: { regionId: input.regionId, weekIso: input.weekIso } }
    });
    const current = decodeLaneWeekMetadata(existing?.laneIssueNotes);
    const marketRates = { ...current.marketRates };
    if (normalized) {
      marketRates[input.lane] = normalized;
    } else {
      delete marketRates[input.lane];
    }
    await tx.weekSnapshot.upsert({
      where: { regionId_weekIso: { regionId: input.regionId, weekIso: input.weekIso } },
      update: { laneIssueNotes: encodeLaneWeekMetadata({ ...current, marketRates }) },
      create: {
        regionId: input.regionId,
        weekIso: input.weekIso,
        laneIssueNotes: encodeLaneWeekMetadata({ marketRates }),
        ...EMPTY_SNAPSHOT_DEFAULTS
      }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "WeekSnapshot",
        entityId: `${input.regionId}:${input.weekIso}`,
        action: "UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: `Lane market target updated for ${input.lane}`,
        afterValue: { lane: input.lane, targetRate: normalized || null }
      })
    });
  });
}

/**
 * The DAT market rate per lane for the week — the external benchmark, distinct from
 * the internal target above. Stored in the separate `datRates` map. Manual for now;
 * the future DAT API will write here too. Empty clears the value.
 */
export async function setLaneDatRate(input: {
  regionId: string;
  weekIso: string;
  lane: string;
  /** Normalized decimal string; empty clears. Caller validates positivity. */
  datRate: string;
  actorId: string;
}): Promise<void> {
  const normalized = input.datRate.trim();
  await runInRegionScope(input.regionId, async (tx) => {
    const existing = await tx.weekSnapshot.findUnique({
      where: { regionId_weekIso: { regionId: input.regionId, weekIso: input.weekIso } }
    });
    const current = decodeLaneWeekMetadata(existing?.laneIssueNotes);
    const datRates = { ...current.datRates };
    if (normalized) {
      datRates[input.lane] = normalized;
    } else {
      delete datRates[input.lane];
    }
    await tx.weekSnapshot.upsert({
      where: { regionId_weekIso: { regionId: input.regionId, weekIso: input.weekIso } },
      update: { laneIssueNotes: encodeLaneWeekMetadata({ ...current, datRates }) },
      create: {
        regionId: input.regionId,
        weekIso: input.weekIso,
        laneIssueNotes: encodeLaneWeekMetadata({ datRates }),
        ...EMPTY_SNAPSHOT_DEFAULTS
      }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "WeekSnapshot",
        entityId: `${input.regionId}:${input.weekIso}`,
        action: "UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: `Lane DAT market rate updated for ${input.lane}`,
        afterValue: { lane: input.lane, datRate: normalized || null }
      })
    });
  });
}
