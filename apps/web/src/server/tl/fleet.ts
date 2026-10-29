import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PAY_KINDS, PROFILE_FIELDS, profileFieldApplies, profileFloors, validateDriver, validateProfile, validateTruck, ymdOf, type DriverValues, type ProfileChoices, type ProfileErrorKey, type ProfileKey, type ProfileNumbers, type TruckValues } from "@/lib/fleet-forms";
import { COST_ARCHETYPES, normalizeArchetype, normalizeFscCutAnswer } from "@/truelane/lib/domain/costArchetype";
import { categoriesCarrySplit, resolveWizardInsurance } from "@/truelane/lib/insuranceFields";
import type { AuditSnapshot } from "@/lib/audit-diff";
import { recordAudit } from "./audit";
import { num, numOrNull } from "./convert";
import { profileMathInput } from "./evaluate";
import { currentWorkspace, DEMO_WORKSPACE_ID } from "./workspace";

/**
 * Who drives and what they drive: adding, changing, deactivating and archiving drivers and trucks, and a truck's cost profile.
 * Nothing that is in use can be taken out of service (a driver on an open load, a truck with an open load), and every change is
 * written to the audit log in the same transaction. A cost profile's floor is recomputed here with TrueLane's function, never
 * taken from the browser.
 */
export type FieldErrors<K extends string> = Partial<Record<K, string>>;
export type SaveResult<K extends string> = { ok: true; id: string; changed: boolean } | { ok: false; errors?: FieldErrors<K>; error?: string };
export type ActResult = { ok: true } | { ok: false; error: string };

const OPEN_LOAD = ["draft", "accepted", "in_progress"];
const OPEN_ASSIGNMENT = ["draft", "dispatched", "accepted", "in_progress"];

const list = (xs: string[]) => (xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more`);
const dollars = (n: number) => `$${n.toFixed(2)}/mi`;

// ── Drivers ────────────────────────────────────────────────────────────────────────────────────

/** "$0.65 a mile", "$22 an hour", "$450 a load", or null when no usual pay is set. */
function payText(kind: string, rate: string): string | null {
  const k = PAY_KINDS.find((x) => x.key === kind);
  if (!k || rate === "") return null;
  return `$${rate} ${k.key === "cpm" ? "a mile" : k.key === "hourly" ? "an hour" : "a load"}`;
}

function driverSnapshot(v: DriverValues, truckName: string | null): AuditSnapshot {
  return { Name: v.name, Phone: v.phone || null, Email: v.email || null, "CDL class": v.cdlClass || null, "CDL good through": v.cdlExpiry || null, "Medical card good through": v.medicalCardExpiry || null, Truck: truckName, "Usual pay": payText(v.payKind, v.payRate) };
}

export async function saveDriver(raw: Record<string, unknown>, id: string | null, now = new Date()): Promise<SaveResult<keyof DriverValues>> {
  const check = validateDriver(raw);
  if (!check.ok) return { ok: false, errors: check.errors };
  const ws = await currentWorkspace();
  const v = check.value;
  const truck = v.assignedVehicleId ? await prisma.vehicle.findFirst({ where: { id: v.assignedVehicleId, workspaceId: ws.id, archivedAt: null } }) : null;
  if (v.assignedVehicleId && !truck) return { ok: false, errors: { assignedVehicleId: "That truck is not available." } };
  const data = { name: v.name, phone: v.phone || null, email: v.email || null, cdlClass: v.cdlClass || null, cdlExpiry: check.cdlExpiry, medicalCardExpiry: check.medicalCardExpiry, assignedVehicleId: truck?.id ?? null, defaultPayKind: v.payKind || null, defaultPayRate: check.payRate };
  const after = driverSnapshot(v, truck?.name ?? null);

  if (id == null) {
    const created = await prisma.$transaction(async (tx) => {
      const d = await tx.driver.create({ data: { workspaceId: ws.id, ...data } });
      await recordAudit({ entity: "fleet", action: "driver_added", summary: `${v.name} added as a driver`, before: null, after, at: now, workspaceId: ws.id }, tx);
      return d;
    });
    return { ok: true, id: created.id, changed: true };
  }

  const prev = await prisma.driver.findFirst({ where: { id, workspaceId: ws.id }, include: { assignedVehicle: true } });
  if (!prev) return { ok: false, error: "That driver does not exist." };
  const before = driverSnapshot(
    { name: prev.name, phone: prev.phone ?? "", email: prev.email ?? "", cdlClass: prev.cdlClass ?? "", cdlExpiry: ymdOf(prev.cdlExpiry), medicalCardExpiry: ymdOf(prev.medicalCardExpiry), assignedVehicleId: prev.assignedVehicleId ?? "", payKind: prev.defaultPayKind ?? "", payRate: prev.defaultPayRate == null ? "" : String(num(prev.defaultPayRate)) },
    prev.assignedVehicle?.name ?? null
  );
  const moved = Object.keys(after).filter((k) => (before[k] ?? null) !== (after[k] ?? null));
  if (moved.length === 0) return { ok: true, id, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.driver.update({ where: { id }, data });
    await recordAudit({ entity: "fleet", action: "driver_changed", summary: `${v.name}: changed ${moved.join(", ").toLowerCase()}`, before, after, at: now, workspaceId: ws.id }, tx);
  });
  return { ok: true, id, changed: true };
}

/** Take a driver out of service, or bring them back. A driver on an open load cannot be taken out until they are off it. */
export async function setDriverActive(id: string, active: boolean, now = new Date()): Promise<ActResult> {
  const d = await prisma.driver.findFirst({ where: { id, workspaceId: DEMO_WORKSPACE_ID }, include: { assignments: { where: { status: { in: OPEN_ASSIGNMENT }, load: { deletedAt: null, status: { in: OPEN_LOAD } } }, include: { load: true } } } });
  if (!d) return { ok: false, error: "That driver does not exist." };
  if (d.active === active) return { ok: true };
  if (!active && d.assignments.length > 0) {
    const nums = d.assignments.map((a) => a.load.loadNumber ?? "a load");
    return { ok: false, error: `${d.name} is on ${list(nums)}. Take them off ${d.assignments.length === 1 ? "it" : "those"} first.` };
  }
  await prisma.$transaction(async (tx) => {
    await tx.driver.update({ where: { id }, data: { active } });
    await recordAudit({ entity: "fleet", action: active ? "driver_reactivated" : "driver_deactivated", summary: `${d.name} ${active ? "brought back" : "taken out of service"}`, before: { Status: d.active ? "Active" : "Deactivated" }, after: { Status: active ? "Active" : "Deactivated" }, at: now }, tx);
  });
  return { ok: true };
}

// ── Trucks ─────────────────────────────────────────────────────────────────────────────────────

function truckSnapshot(v: TruckValues): AuditSnapshot {
  return { Name: v.name, Type: v.type || null, "Miles per gallon": v.mpg || null, Fuel: v.fuelType || null, "Home base": v.homeBaseAddress || null };
}

export async function saveTruck(raw: Record<string, unknown>, id: string | null, now = new Date()): Promise<SaveResult<keyof TruckValues>> {
  const check = validateTruck(raw);
  if (!check.ok) return { ok: false, errors: check.errors };
  const ws = await currentWorkspace();
  const v = check.value;
  const clash = await prisma.vehicle.findFirst({ where: { workspaceId: ws.id, archivedAt: null, name: { equals: v.name, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) } });
  if (clash) return { ok: false, errors: { name: "A truck with that name already exists." } };
  const data = { name: v.name, type: v.type || null, mpg: check.mpg, fuelType: v.fuelType || null, homeBaseAddress: v.homeBaseAddress || null };
  const after = truckSnapshot(v);

  if (id == null) {
    const created = await prisma.$transaction(async (tx) => {
      const t = await tx.vehicle.create({ data: { workspaceId: ws.id, ...data } });
      await recordAudit({ entity: "fleet", action: "truck_added", summary: `${v.name} added as a truck`, before: null, after, at: now, workspaceId: ws.id }, tx);
      return t;
    });
    return { ok: true, id: created.id, changed: true };
  }
  const prev = await prisma.vehicle.findFirst({ where: { id, workspaceId: ws.id } });
  if (!prev) return { ok: false, error: "That truck does not exist." };
  const before = truckSnapshot({ name: prev.name ?? "", type: prev.type ?? "", mpg: prev.mpg == null ? "" : String(num(prev.mpg)), fuelType: prev.fuelType ?? "", homeBaseAddress: prev.homeBaseAddress ?? "" });
  const moved = Object.keys(after).filter((k) => String(before[k] ?? "") !== String(after[k] ?? ""));
  if (moved.length === 0) return { ok: true, id, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.vehicle.update({ where: { id }, data });
    await recordAudit({ entity: "fleet", action: "truck_changed", summary: `${v.name}: changed ${moved.join(", ").toLowerCase()}`, before, after, at: now, workspaceId: ws.id }, tx);
  });
  return { ok: true, id, changed: true };
}

/** Archive a truck (hide it from new work, keep its history), or restore it. A truck with an open load cannot be archived. */
export async function setTruckArchived(id: string, archived: boolean, now = new Date()): Promise<ActResult> {
  const t = await prisma.vehicle.findFirst({ where: { id, workspaceId: DEMO_WORKSPACE_ID }, include: { loads: { where: { deletedAt: null, status: { in: OPEN_LOAD } } }, drivers: { where: { active: true } } } });
  if (!t) return { ok: false, error: "That truck does not exist." };
  const isArchived = t.archivedAt != null;
  if (isArchived === archived) return { ok: true };
  if (archived && t.loads.length > 0) {
    return { ok: false, error: `${t.name} is on ${list(t.loads.map((l) => l.loadNumber ?? "a load"))}. Finish or move ${t.loads.length === 1 ? "that load" : "those loads"} first.` };
  }
  await prisma.$transaction(async (tx) => {
    await tx.vehicle.update({ where: { id }, data: archived ? { archivedAt: now, active: false } : { archivedAt: null, active: true } });
    if (archived && t.drivers.length > 0) await tx.driver.updateMany({ where: { assignedVehicleId: id }, data: { assignedVehicleId: null } });
    await recordAudit(
      {
        entity: "fleet",
        action: archived ? "truck_archived" : "truck_restored",
        summary: `${t.name} ${archived ? `archived${t.drivers.length > 0 ? `; ${list(t.drivers.map((d) => d.name))} no longer assigned to it` : ""}` : "restored"}`,
        before: { Status: isArchived ? "Archived" : "In service" },
        after: { Status: archived ? "Archived" : "In service" },
        at: now
      },
      tx
    );
  });
  return { ok: true };
}

// ── Cost profile ───────────────────────────────────────────────────────────────────────────────

/** Fields saved as null when left blank; the rest save 0 (or their own default, see profileRecord). */
const NULLABLE: ProfileKey[] = ["truckReplacementMonthly", "annualFixedCosts", "otherFixedMonthly", "lastFuelPricePerGallon", "detentionHourlyRate", "freeGraceMinutes"];
/** The daily revenue target a blank field means: the phone's own default. */
const DEFAULT_DAILY_TARGET = 350;
const PERCENT_KEYS = PROFILE_FIELDS.filter((f) => f.percent).map((f) => f.key);
const BUCKET_KEYS: ProfileKey[] = ["insuranceLiabilityMonthly", "insurancePhysicalDamageMonthly", "insuranceCargoMonthly", "insuranceGeneralLiabilityMonthly", "insuranceOtherMonthly"];
const ROUTE_KEYS: ProfileKey[] = ["routeBaseMinimum", "routeIncludedMiles", "routeIncludedStops", "routeOveragePerMile", "routeOveragePerStop"];
/** Written one by one in profileRecord, not by the general rule. */
const SPECIAL: ProfileKey[] = [...BUCKET_KEYS, ...ROUTE_KEYS, ...PERCENT_KEYS, "monthlyInsurance", "dailyRevenueTarget", "hiredDriverHourlyRate", "hiredDriverRatePerMile"];

const fraction = (percent: number | null): Prisma.Decimal | null => (percent == null ? null : new Prisma.Decimal(percent).div(100).toDecimalPlaces(4));

/** A stored cost profile as the form's numbers (percents as typed, 18 for 0.18). */
export function profileNumbersOf(p: Record<string, unknown> | null): ProfileNumbers {
  const out = {} as ProfileNumbers;
  for (const f of PROFILE_FIELDS) {
    const raw = p?.[f.key];
    out[f.key] = raw == null ? null : f.percent ? new Prisma.Decimal(raw as never).mul(100).toDecimalPlaces(4).toNumber() : numOrNull(raw as never);
  }
  return out;
}

/** The answers that are not numbers, read back from a stored profile. A truck with no profile yet starts as Owner + driver: the drivers work for the fleet. */
export function profileChoicesOf(p: Record<string, unknown> | null): ProfileChoices {
  if (!p) return { archetype: "hired_driver", payKind: "hourly", fscCut: null, insuranceItemised: false, routeMinimumOn: false };
  const buckets = {
    liability: num(p.insuranceLiabilityMonthly as never),
    physicalDamage: num(p.insurancePhysicalDamageMonthly as never),
    cargo: num(p.insuranceCargoMonthly as never),
    generalLiability: num(p.insuranceGeneralLiabilityMonthly as never),
    other: num(p.insuranceOtherMonthly as never)
  };
  return {
    archetype: normalizeArchetype(p.archetype as string | null),
    payKind: p.hiredDriverPayKind === "cpm" ? "cpm" : "hourly",
    fscCut: normalizeFscCutAnswer(p.fscCutApplies as string | null),
    insuranceItemised: categoriesCarrySplit(buckets),
    routeMinimumOn: num(p.routeBaseMinimum as never) > 0
  };
}

/**
 * What is written for a checked form. Fields the answers do not use are left as they were, as the phone does, so switching a truck
 * from Owner + driver to Leased-on and back finds the driver's pay where it was.
 */
export function profileRecord(numbers: ProfileNumbers, choices: ProfileChoices, now: Date): Record<string, unknown> {
  const n = (k: ProfileKey) => numbers[k];
  const rec: Record<string, unknown> = {};
  for (const f of PROFILE_FIELDS) if (!SPECIAL.includes(f.key)) rec[f.key] = n(f.key) ?? (NULLABLE.includes(f.key) ? null : 0);

  const ins = resolveWizardInsurance(
    n("monthlyInsurance") ?? 0,
    { liability: n("insuranceLiabilityMonthly") ?? 0, physicalDamage: n("insurancePhysicalDamageMonthly") ?? 0, cargo: n("insuranceCargoMonthly") ?? 0, generalLiability: n("insuranceGeneralLiabilityMonthly") ?? 0, other: n("insuranceOtherMonthly") ?? 0 },
    choices.insuranceItemised
  );
  rec.monthlyInsurance = ins.monthlyInsurance;
  rec.insuranceLiabilityMonthly = ins.categories.liability;
  rec.insurancePhysicalDamageMonthly = ins.categories.physicalDamage;
  rec.insuranceCargoMonthly = ins.categories.cargo;
  rec.insuranceGeneralLiabilityMonthly = ins.categories.generalLiability;
  rec.insuranceOtherMonthly = ins.categories.other;

  rec.dailyRevenueTarget = n("dailyRevenueTarget") ?? DEFAULT_DAILY_TARGET;
  rec.factoringFeePct = fraction(n("factoringFeePct")) ?? 0;
  rec.archetype = choices.archetype;
  rec.hiredDriverPayKind = choices.payKind;

  if (choices.archetype === "hired_driver") {
    if (choices.payKind === "cpm") rec.hiredDriverRatePerMile = n("hiredDriverRatePerMile");
    else rec.hiredDriverHourlyRate = n("hiredDriverHourlyRate");
    rec.laborBurdenPct = fraction(n("laborBurdenPct"));
    rec.hourlyTargetConfirmedAt = now;
  }
  if (choices.archetype === "leased_on") {
    rec.carrierCutPct = fraction(n("carrierCutPct"));
    rec.fscCutApplies = choices.fscCut;
  }
  for (const k of ROUTE_KEYS) rec[k] = choices.routeMinimumOn ? (n(k) ?? null) : null;
  return rec;
}

const CHOICE_LABEL = { archetype: "Who drives", payKind: "Driver pay basis", fscCut: "Cut taken from fuel surcharge", insuranceItemised: "Insurance itemised", routeMinimum: "Route minimum" };

/** The applicable numbers and the answers as label/value pairs, for the audit diff and the "nothing changed" check. */
function profileFlat(numbers: ProfileNumbers, choices: ProfileChoices): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const f of PROFILE_FIELDS) if (profileFieldApplies(f.key, choices)) out[`${f.label} (${f.unit})`] = numbers[f.key] ?? (NULLABLE.includes(f.key) ? null : 0);
  out[CHOICE_LABEL.archetype] = COST_ARCHETYPES.find((a) => a.value === choices.archetype)?.label ?? choices.archetype;
  if (choices.archetype === "hired_driver") out[CHOICE_LABEL.payKind] = choices.payKind === "cpm" ? "Per mile" : "Hourly";
  if (choices.archetype === "leased_on") out[CHOICE_LABEL.fscCut] = choices.fscCut === "yes" ? "Yes" : choices.fscCut === "no" ? "No" : choices.fscCut === "not_sure" ? "Not sure" : null;
  out[CHOICE_LABEL.insuranceItemised] = choices.insuranceItemised ? "Yes" : "No";
  out[CHOICE_LABEL.routeMinimum] = choices.routeMinimumOn ? "On" : "Off";
  return out;
}

export async function saveCostProfile(vehicleId: string, raw: Record<string, unknown>, now = new Date()): Promise<SaveResult<ProfileErrorKey> & { floors?: { breakEven: number; survival: number } }> {
  const check = validateProfile(raw);
  if (!check.ok) return { ok: false, errors: check.errors };
  const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, workspaceId: DEMO_WORKSPACE_ID }, include: { costProfile: true } });
  if (!vehicle) return { ok: false, error: "That truck does not exist." };

  const prev = vehicle.costProfile;
  const base = prev ? profileMathInput(prev as never) : {};
  const floors = profileFloors(check.numbers, check.choices, base);
  const breakEven = new Prisma.Decimal(floors.breakEvenRpm).toDecimalPlaces(4);
  const survival = new Prisma.Decimal(floors.survivalFloorRpm).toDecimalPlaces(4);
  const result = { floors: { breakEven: breakEven.toNumber(), survival: survival.toNumber() } };

  const before = prev ? profileFlat(profileNumbersOf(prev as never), profileChoicesOf(prev as never)) : {};
  const after = profileFlat(check.numbers, check.choices);
  const moved = Object.keys(after).filter((k) => (prev ? before[k] : undefined) !== after[k] && !(prev && before[k] === undefined && after[k] === null));
  const floorMoved = prev != null && (num(prev.breakEvenRpm) !== breakEven.toNumber() || numOrNull(prev.survivalFloorRpm) !== survival.toNumber());
  if (prev && moved.length === 0 && !floorMoved) return { ok: true, id: vehicleId, changed: false, ...result };

  await prisma.$transaction(async (tx) => {
    const common = { ...profileRecord(check.numbers, check.choices, now), breakEvenRpm: breakEven, survivalFloorRpm: survival };
    if (prev) await tx.costProfile.update({ where: { vehicleId }, data: common as Prisma.CostProfileUncheckedUpdateInput });
    else await tx.costProfile.create({ data: { ...(common as Omit<Prisma.CostProfileUncheckedCreateInput, "vehicleId">), vehicleId } });
    await recordAudit(
      {
        entity: "fleet",
        action: "cost_profile_changed",
        summary: prev && !floorMoved ? `${vehicle.name}: cost profile changed, the break-even floor stays ${dollars(breakEven.toNumber())}` : `${vehicle.name}: break-even floor ${prev ? `${dollars(num(prev.breakEvenRpm))} to ` : ""}${dollars(breakEven.toNumber())}`,
        before: { "Break-even floor": prev ? dollars(num(prev.breakEvenRpm)) : null, "Survival floor": prev ? dollars(num(prev.survivalFloorRpm)) : null, ...Object.fromEntries(moved.map((k) => [k, before[k] ?? null])) },
        after: { "Break-even floor": dollars(breakEven.toNumber()), "Survival floor": dollars(survival.toNumber()), ...Object.fromEntries(moved.map((k) => [k, after[k] ?? null])) },
        at: now
      },
      tx
    );
  });
  return { ok: true, id: vehicleId, changed: true, ...result };
}

/** One truck with its cost profile as form numbers and answers, the part of the profile the form does not edit, and what is on it now. */
export async function getTruckDetail(id: string, workspaceId = DEMO_WORKSPACE_ID) {
  const t = await prisma.vehicle.findFirst({
    where: { id, workspaceId },
    include: { costProfile: true, drivers: { where: { active: true }, orderBy: { name: "asc" } }, loads: { where: { deletedAt: null, status: { in: OPEN_LOAD } }, orderBy: { scheduledDate: "asc" } } }
  });
  if (!t) return null;
  const p = t.costProfile;
  return {
    vehicle: t,
    numbers: profileNumbersOf(p as never),
    choices: profileChoicesOf(p as never),
    /** What the form does not edit (the self-employment reserve), so the preview uses the same inputs the stored floor did. */
    base: p ? profileMathInput(p as never) : {},
    stored: p ? { breakEven: num(p.breakEvenRpm), survival: numOrNull(p.survivalFloorRpm) } : null
  };
}
