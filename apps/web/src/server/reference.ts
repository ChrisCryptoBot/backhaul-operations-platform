import { BrokerOnboardingStatus, CadencePeriod, DayOfWeek, DriverAttribute, Prisma } from "@prisma/client";
import { runInRegionScope } from "@/lib/db";
import { withNonDeletedRegionScope } from "@/lib/scoped-query";
import { createAuditLog } from "@/lib/audit";

/**
 * Reference-data action layer (brokers + broker reps for now; lanes/drop-lots follow).
 * Mirrors `server/board.ts` conventions: every mutation is region-scoped via
 * `runInRegionScope`, filters soft-deleted rows with `withNonDeletedRegionScope`, and
 * is audit-logged with the actor. Validation lives at the route, not here. RBAC
 * (REFERENCE_DATA:WRITE → REGIONAL_MANAGER+) is enforced by the caller (API route /
 * copilot dispatch) before these run.
 */

export interface BrokerRepSummary {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface BrokerSummary {
  id: string;
  name: string;
  onboardingStatus: BrokerOnboardingStatus;
  fscDefaultApplies: boolean;
  reps: BrokerRepSummary[];
  createdAt: string;
  updatedAt: string;
}

export async function listBrokers(input: { regionId: string }): Promise<BrokerSummary[]> {
  return runInRegionScope(input.regionId, async (tx) => {
    const brokers = await tx.broker.findMany({
      where: withNonDeletedRegionScope(input.regionId),
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        onboardingStatus: true,
        fscDefaultApplies: true,
        createdAt: true,
        updatedAt: true,
        brokerReps: {
          where: { deletedAt: null },
          orderBy: { name: "asc" },
          select: { id: true, name: true, email: true, phone: true }
        }
      }
    });
    return brokers.map((broker) => ({
      id: broker.id,
      name: broker.name,
      onboardingStatus: broker.onboardingStatus,
      fscDefaultApplies: broker.fscDefaultApplies,
      createdAt: broker.createdAt.toISOString(),
      updatedAt: broker.updatedAt.toISOString(),
      reps: broker.brokerReps.map((rep) => ({
        id: rep.id,
        name: rep.name,
        email: rep.email,
        phone: rep.phone
      }))
    }));
  });
}

export async function createBroker(input: {
  regionId: string;
  actorId: string;
  name: string;
  onboardingStatus?: BrokerOnboardingStatus;
  fscDefaultApplies?: boolean;
}): Promise<{ id: string; name: string }> {
  return runInRegionScope(input.regionId, async (tx) => {
    const broker = await tx.broker.create({
      data: {
        regionId: input.regionId,
        name: input.name,
        onboardingStatus: input.onboardingStatus ?? BrokerOnboardingStatus.PENDING,
        fscDefaultApplies: input.fscDefaultApplies ?? true
      },
      select: { id: true, name: true }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Broker",
        entityId: broker.id,
        action: "REFERENCE_BROKER_CREATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: {
          name: input.name,
          onboardingStatus: input.onboardingStatus ?? BrokerOnboardingStatus.PENDING,
          fscDefaultApplies: input.fscDefaultApplies ?? true
        }
      })
    });
    return broker;
  });
}

export async function updateBroker(input: {
  regionId: string;
  actorId: string;
  brokerId: string;
  fields: Partial<{
    name: string;
    onboardingStatus: BrokerOnboardingStatus;
    fscDefaultApplies: boolean;
  }>;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const broker = await tx.broker.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.brokerId }),
      select: { id: true }
    });
    if (!broker) throw new Error("Broker not found.");

    await tx.broker.update({
      where: { id: broker.id },
      data: input.fields
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Broker",
        entityId: broker.id,
        action: "REFERENCE_BROKER_UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: input.fields
      })
    });
  });
}

export async function softDeleteBroker(input: {
  regionId: string;
  actorId: string;
  brokerId: string;
  reason: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const broker = await tx.broker.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.brokerId }),
      select: { id: true }
    });
    if (!broker) throw new Error("Broker not found.");

    await tx.broker.update({
      where: { id: broker.id },
      data: { deletedAt: new Date() }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Broker",
        entityId: broker.id,
        action: "REFERENCE_BROKER_DELETE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: input.reason
      })
    });
  });
}

/** Confirms a broker exists (non-deleted) in the region; throws otherwise. */
async function assertBrokerInRegion(
  tx: Prisma.TransactionClient,
  regionId: string,
  brokerId: string
): Promise<string> {
  const broker = await tx.broker.findFirst({
    where: withNonDeletedRegionScope(regionId, { id: brokerId }),
    select: { id: true }
  });
  if (!broker) throw new Error("Broker not found.");
  return broker.id;
}

export async function addBrokerRep(input: {
  regionId: string;
  actorId: string;
  brokerId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}): Promise<{ id: string }> {
  return runInRegionScope(input.regionId, async (tx) => {
    const brokerId = await assertBrokerInRegion(tx, input.regionId, input.brokerId);
    const rep = await tx.brokerRep.create({
      data: {
        brokerId,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null
      },
      select: { id: true }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "BrokerRep",
        entityId: rep.id,
        action: "REFERENCE_BROKER_REP_CREATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: { brokerId, name: input.name, email: input.email ?? null, phone: input.phone ?? null }
      })
    });
    return rep;
  });
}

export async function updateBrokerRep(input: {
  regionId: string;
  actorId: string;
  brokerId: string;
  repId: string;
  fields: Partial<{ name: string; email: string | null; phone: string | null }>;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const brokerId = await assertBrokerInRegion(tx, input.regionId, input.brokerId);
    const rep = await tx.brokerRep.findFirst({
      where: { id: input.repId, brokerId, deletedAt: null },
      select: { id: true }
    });
    if (!rep) throw new Error("Broker rep not found.");

    await tx.brokerRep.update({
      where: { id: rep.id },
      data: input.fields
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "BrokerRep",
        entityId: rep.id,
        action: "REFERENCE_BROKER_REP_UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: input.fields
      })
    });
  });
}

export async function softDeleteBrokerRep(input: {
  regionId: string;
  actorId: string;
  brokerId: string;
  repId: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const brokerId = await assertBrokerInRegion(tx, input.regionId, input.brokerId);
    const rep = await tx.brokerRep.findFirst({
      where: { id: input.repId, brokerId, deletedAt: null },
      select: { id: true }
    });
    if (!rep) throw new Error("Broker rep not found.");

    await tx.brokerRep.update({
      where: { id: rep.id },
      data: { deletedAt: new Date() }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "BrokerRep",
        entityId: rep.id,
        action: "REFERENCE_BROKER_REP_DELETE",
        actorId: input.actorId,
        timestamp: new Date()
      })
    });
  });
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export interface LaneSummary {
  id: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  targetRate: string;
}

export async function listLanes(input: { regionId: string }): Promise<LaneSummary[]> {
  return runInRegionScope(input.regionId, async (tx) => {
    const lanes = await tx.lane.findMany({
      where: withNonDeletedRegionScope(input.regionId),
      orderBy: [{ originCity: "asc" }, { destinationCity: "asc" }],
      select: {
        id: true,
        originCity: true,
        originState: true,
        destinationCity: true,
        destinationState: true,
        targetRate: true
      }
    });
    return lanes.map((lane) => ({
      id: lane.id,
      originCity: lane.originCity,
      originState: lane.originState,
      destinationCity: lane.destinationCity,
      destinationState: lane.destinationState,
      targetRate: lane.targetRate.toString()
    }));
  });
}

export async function createLane(input: {
  regionId: string;
  actorId: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  targetRate: string;
}): Promise<{ id: string }> {
  return runInRegionScope(input.regionId, async (tx) => {
    let lane: { id: string };
    try {
      lane = await tx.lane.create({
        data: {
          regionId: input.regionId,
          originCity: input.originCity,
          originState: input.originState,
          destinationCity: input.destinationCity,
          destinationState: input.destinationState,
          targetRate: new Prisma.Decimal(input.targetRate)
        },
        select: { id: true }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new Error("A lane with this origin and destination already exists.");
      }
      throw error;
    }
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Lane",
        entityId: lane.id,
        action: "REFERENCE_LANE_CREATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: {
          originCity: input.originCity,
          originState: input.originState,
          destinationCity: input.destinationCity,
          destinationState: input.destinationState,
          targetRate: input.targetRate
        }
      })
    });
    return lane;
  });
}

export async function setLaneTarget(input: {
  regionId: string;
  actorId: string;
  laneId: string;
  targetRate: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const lane = await tx.lane.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.laneId }),
      select: { id: true }
    });
    if (!lane) throw new Error("Lane not found.");

    await tx.lane.update({
      where: { id: lane.id },
      data: { targetRate: new Prisma.Decimal(input.targetRate) }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Lane",
        entityId: lane.id,
        action: "REFERENCE_LANE_SET_TARGET",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: { targetRate: input.targetRate }
      })
    });
  });
}

export async function softDeleteLane(input: {
  regionId: string;
  actorId: string;
  laneId: string;
  reason: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const lane = await tx.lane.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.laneId }),
      select: { id: true }
    });
    if (!lane) throw new Error("Lane not found.");

    await tx.lane.update({
      where: { id: lane.id },
      data: { deletedAt: new Date() }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Lane",
        entityId: lane.id,
        action: "REFERENCE_LANE_DELETE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: input.reason
      })
    });
  });
}

// ---------------------------------------------------------------------------
// Drop lots
// ---------------------------------------------------------------------------

export interface DropLotSummary {
  id: string;
  name: string;
  code: string | null;
  note: string | null;
  city: string;
  state: string;
  sortOrder: number;
  dailyCapacity: number | null;
  slipSeat: boolean;
  dropHookRequired: boolean;
}

type DropLotWritableFields = {
  name: string;
  code: string | null;
  note: string | null;
  city: string;
  state: string;
  sortOrder: number;
  dailyCapacity: number | null;
  slipSeat: boolean;
  dropHookRequired: boolean;
};

export async function listDropLots(input: { regionId: string }): Promise<DropLotSummary[]> {
  return runInRegionScope(input.regionId, async (tx) => {
    const lots = await tx.dropLot.findMany({
      where: withNonDeletedRegionScope(input.regionId),
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        code: true,
        note: true,
        city: true,
        state: true,
        sortOrder: true,
        dailyCapacity: true,
        slipSeat: true,
        dropHookRequired: true
      }
    });
    return lots;
  });
}

export async function createDropLot(input: {
  regionId: string;
  actorId: string;
  fields: DropLotWritableFields;
}): Promise<{ id: string }> {
  return runInRegionScope(input.regionId, async (tx) => {
    const lot = await tx.dropLot.create({
      data: { regionId: input.regionId, ...input.fields },
      select: { id: true }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "DropLot",
        entityId: lot.id,
        action: "REFERENCE_DROP_LOT_CREATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: { name: input.fields.name, city: input.fields.city, state: input.fields.state }
      })
    });
    return lot;
  });
}

export async function updateDropLot(input: {
  regionId: string;
  actorId: string;
  dropLotId: string;
  fields: Partial<DropLotWritableFields>;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const lot = await tx.dropLot.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.dropLotId }),
      select: { id: true }
    });
    if (!lot) throw new Error("Drop lot not found.");

    await tx.dropLot.update({
      where: { id: lot.id },
      data: input.fields
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "DropLot",
        entityId: lot.id,
        action: "REFERENCE_DROP_LOT_UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: input.fields
      })
    });
  });
}

export async function softDeleteDropLot(input: {
  regionId: string;
  actorId: string;
  dropLotId: string;
  reason: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const lot = await tx.dropLot.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.dropLotId }),
      select: { id: true }
    });
    if (!lot) throw new Error("Drop lot not found.");

    // Drop lots are referenced by loads with onDelete: Restrict. Block removal while
    // any non-deleted load still points at this lot (clear message instead of an FK error).
    const referencingLoads = await tx.load.count({
      where: withNonDeletedRegionScope(input.regionId, { dropLotId: lot.id })
    });
    if (referencingLoads > 0) {
      throw new Error(`Drop lot is in use by ${referencingLoads} load(s) and cannot be removed.`);
    }

    await tx.dropLot.update({
      where: { id: lot.id },
      data: { deletedAt: new Date() }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "DropLot",
        entityId: lot.id,
        action: "REFERENCE_DROP_LOT_DELETE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: input.reason
      })
    });
  });
}

// ---------------------------------------------------------------------------
// Distribution centers (read-only here; used to resolve a load's destination)
// ---------------------------------------------------------------------------

export interface DistributionCenterSummary {
  id: string;
  name: string;
  city: string;
  state: string;
}

export async function listDistributionCenters(input: { regionId: string }): Promise<DistributionCenterSummary[]> {
  return runInRegionScope(input.regionId, async (tx) => {
    const centers = await tx.distributionCenter.findMany({
      where: withNonDeletedRegionScope(input.regionId),
      orderBy: { name: "asc" },
      select: { id: true, name: true, city: true, state: true }
    });
    return centers;
  });
}

// ---------------------------------------------------------------------------
// Drivers (Phase 1 — Daily Booking Plan foundation)
// Append to apps/web/src/server/reference.ts.
// ALSO extend the file's first import line to:
//   import { BrokerOnboardingStatus, CadencePeriod, DayOfWeek, DriverAttribute, Prisma } from "@prisma/client";
// ---------------------------------------------------------------------------

export interface DriverSummary {
  id: string;
  code: string;
  fullName: string;
  phone: string | null;
  active: boolean;
  homeDropLotId: string | null;
  homeDropLot: { id: string; name: string; code: string | null } | null;
  attributes: DriverAttribute[];
  scheduleDays: DayOfWeek[];
  scheduleStart: string | null;
  scheduleTimeZone: string | null;
  scheduleNote: string | null;
  createdAt: string;
  updatedAt: string;
}

type DriverWritableFields = {
  code: string;
  fullName: string;
  phone: string | null;
  homeDropLotId: string | null;
  active: boolean;
  attributes: DriverAttribute[];
  scheduleDays: DayOfWeek[];
  scheduleStart: string | null;
  scheduleTimeZone: string | null;
  scheduleNote: string | null;
};

/** Confirms a drop lot exists (non-deleted) in the region; throws otherwise. */
async function assertDropLotInRegion(
  tx: Prisma.TransactionClient,
  regionId: string,
  dropLotId: string
): Promise<void> {
  const lot = await tx.dropLot.findFirst({
    where: withNonDeletedRegionScope(regionId, { id: dropLotId }),
    select: { id: true }
  });
  if (!lot) throw new Error("Drop lot not found.");
}

export async function listDrivers(input: { regionId: string }): Promise<DriverSummary[]> {
  return runInRegionScope(input.regionId, async (tx) => {
    const drivers = await tx.driver.findMany({
      where: withNonDeletedRegionScope(input.regionId),
      orderBy: { code: "asc" },
      select: {
        id: true,
        code: true,
        fullName: true,
        phone: true,
        active: true,
        homeDropLotId: true,
        homeDropLot: { select: { id: true, name: true, code: true } },
        attributes: true,
        scheduleDays: true,
        scheduleStart: true,
        scheduleTimeZone: true,
        scheduleNote: true,
        createdAt: true,
        updatedAt: true
      }
    });
    return drivers.map((driver) => ({
      id: driver.id,
      code: driver.code,
      fullName: driver.fullName,
      phone: driver.phone,
      active: driver.active,
      homeDropLotId: driver.homeDropLotId,
      homeDropLot: driver.homeDropLot,
      attributes: driver.attributes,
      scheduleDays: driver.scheduleDays,
      scheduleStart: driver.scheduleStart,
      scheduleTimeZone: driver.scheduleTimeZone,
      scheduleNote: driver.scheduleNote,
      createdAt: driver.createdAt.toISOString(),
      updatedAt: driver.updatedAt.toISOString()
    }));
  });
}

export async function createDriver(input: {
  regionId: string;
  actorId: string;
  fields: DriverWritableFields;
}): Promise<{ id: string }> {
  return runInRegionScope(input.regionId, async (tx) => {
    if (input.fields.homeDropLotId) {
      await assertDropLotInRegion(tx, input.regionId, input.fields.homeDropLotId);
    }
    let driver: { id: string };
    try {
      driver = await tx.driver.create({
        data: { regionId: input.regionId, ...input.fields },
        select: { id: true }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new Error(`A driver with code "${input.fields.code}" already exists in this region.`);
      }
      throw error;
    }
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Driver",
        entityId: driver.id,
        action: "REFERENCE_DRIVER_CREATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: {
          code: input.fields.code,
          fullName: input.fields.fullName,
          active: input.fields.active,
          homeDropLotId: input.fields.homeDropLotId
        }
      })
    });
    return driver;
  });
}

export async function updateDriver(input: {
  regionId: string;
  actorId: string;
  driverId: string;
  fields: Partial<DriverWritableFields>;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const driver = await tx.driver.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.driverId }),
      select: { id: true }
    });
    if (!driver) throw new Error("Driver not found.");

    if (input.fields.homeDropLotId) {
      await assertDropLotInRegion(tx, input.regionId, input.fields.homeDropLotId);
    }

    try {
      await tx.driver.update({
        where: { id: driver.id },
        data: input.fields
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new Error(`A driver with code "${input.fields.code ?? ""}" already exists in this region.`);
      }
      throw error;
    }
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Driver",
        entityId: driver.id,
        action: "REFERENCE_DRIVER_UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: input.fields
      })
    });
  });
}

export async function softDeleteDriver(input: {
  regionId: string;
  actorId: string;
  driverId: string;
  reason: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const driver = await tx.driver.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.driverId }),
      select: { id: true }
    });
    if (!driver) throw new Error("Driver not found.");

    // Block removal while any non-deleted load (either driver slot) or relay leg
    // still resolves to this driver (clear message instead of dangling refs).
    const referencingLoads = await tx.load.count({
      where: withNonDeletedRegionScope(input.regionId, {
        OR: [{ pickupDriverId: driver.id }, { deliveryDriverId: driver.id }]
      })
    });
    const referencingLegs = await tx.loadLeg.count({
      where: { driverId: driver.id, load: { deletedAt: null } }
    });
    const inUseCount = referencingLoads + referencingLegs;
    if (inUseCount > 0) {
      throw new Error(`Driver is in use by ${inUseCount} load record(s) and cannot be removed.`);
    }

    await tx.driver.update({
      where: { id: driver.id },
      data: { deletedAt: new Date() }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Driver",
        entityId: driver.id,
        action: "REFERENCE_DRIVER_DELETE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: input.reason
      })
    });
  });
}

// ---------------------------------------------------------------------------
// Direct customers
// ---------------------------------------------------------------------------

export interface DirectCustomerSummary {
  id: string;
  name: string;
  cadenceCount: number | null;
  cadencePeriod: CadencePeriod | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

type DirectCustomerWritableFields = {
  name: string;
  cadenceCount: number | null;
  cadencePeriod: CadencePeriod | null;
  notes: string | null;
};

export async function listDirectCustomers(input: { regionId: string }): Promise<DirectCustomerSummary[]> {
  return runInRegionScope(input.regionId, async (tx) => {
    const customers = await tx.directCustomer.findMany({
      where: withNonDeletedRegionScope(input.regionId),
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        cadenceCount: true,
        cadencePeriod: true,
        notes: true,
        createdAt: true,
        updatedAt: true
      }
    });
    return customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      cadenceCount: customer.cadenceCount,
      cadencePeriod: customer.cadencePeriod,
      notes: customer.notes,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString()
    }));
  });
}

export async function createDirectCustomer(input: {
  regionId: string;
  actorId: string;
  fields: DirectCustomerWritableFields;
}): Promise<{ id: string }> {
  return runInRegionScope(input.regionId, async (tx) => {
    const customer = await tx.directCustomer.create({
      data: { regionId: input.regionId, ...input.fields },
      select: { id: true }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "DirectCustomer",
        entityId: customer.id,
        action: "REFERENCE_DIRECT_CUSTOMER_CREATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: {
          name: input.fields.name,
          cadenceCount: input.fields.cadenceCount,
          cadencePeriod: input.fields.cadencePeriod
        }
      })
    });
    return customer;
  });
}

export async function updateDirectCustomer(input: {
  regionId: string;
  actorId: string;
  directCustomerId: string;
  fields: Partial<DirectCustomerWritableFields>;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const customer = await tx.directCustomer.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.directCustomerId }),
      select: { id: true }
    });
    if (!customer) throw new Error("Direct customer not found.");

    await tx.directCustomer.update({
      where: { id: customer.id },
      data: input.fields
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "DirectCustomer",
        entityId: customer.id,
        action: "REFERENCE_DIRECT_CUSTOMER_UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: input.fields
      })
    });
  });
}

export async function softDeleteDirectCustomer(input: {
  regionId: string;
  actorId: string;
  directCustomerId: string;
  reason: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const customer = await tx.directCustomer.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.directCustomerId }),
      select: { id: true }
    });
    if (!customer) throw new Error("Direct customer not found.");

    await tx.directCustomer.update({
      where: { id: customer.id },
      data: { deletedAt: new Date() }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "DirectCustomer",
        entityId: customer.id,
        action: "REFERENCE_DIRECT_CUSTOMER_DELETE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: input.reason
      })
    });
  });
}
