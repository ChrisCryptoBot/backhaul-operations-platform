import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { EVIDENCE_RADIUS_MILES, canonicalEvidence, checkConfirmation, keepFixes, parseTypedMinutes, proposeStopEvidence, trackWindow, worthOf, type ConfirmInput, type Fix, type KeptFix, type Quality } from "@/lib/detention-evidence";
import { dateTime } from "@/lib/desk-format";
import { toCentralLocal } from "@/lib/zoned";
import type { Terminals } from "@/lib/scope";
import { recordAudit } from "./audit";
import { numOrNull } from "./convert";
import { correctTrip } from "./execution";
import { currentActor } from "./identity";
import { currentAllowed } from "./scope";
import { stopClocksOf } from "./stop-clock";
import { inTerminal } from "./terminal-sql";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * The detention evidence pack (docs/DETENTION_EVIDENCE.md). When a load is delivered, what the truck's own track says about each stop is frozen into `stop_evidence` (the position fixes themselves are deleted
 * after a week, a claim is made weeks later). A proposal changes nothing: a person with the `figures` capability confirms it, and only then is the stop's arrival and wait written, through the same
 * `correctTrip` every other correction uses, so the audit trail, the dock wait, the Invoices recovery and the invoice's Detention line need no new money code.
 */
const DAY = 86_400_000;
const MAX_PINGS = 20_000;
/** A catch-up looks at loads delivered this recently: inside the week the fixes are kept. */
export const CATCH_UP_DAYS = 6;
export const CATCH_UP_LOADS = 500;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
const when = (n: number | null): Date | null => (n == null ? null : new Date(n));

export type FreezeCounts = { created: number; improved: number; unchanged: number; noCoordinates: number; noFixes: number };
const noneFrozen = (): FreezeCounts => ({ created: 0, improved: 0, unchanged: 0, noCoordinates: 0, noFixes: 0 });

type StoredFix = { at: number; lat: number; lng: number; miles: number };
const fixesOf = (json: unknown): KeptFix[] => (Array.isArray(json) ? (json as StoredFix[]).map((f) => ({ at: f.at, lat: f.lat, lng: f.lng, miles: f.miles })) : []);

/**
 * Freezes what the truck's track says about each placed stop of a delivered load. Idempotent: a stop that already has evidence keeps it, unless its proposal is still undecided and the track now shows more of
 * the visit (never less: once the fixes are deleted a second look would find nothing, and must not erase the proof). A stop with no coordinates, or a truck with no fixes near it, gets no row.
 */
export async function freezeEvidence(loadId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FreezeCounts> {
  const out = noneFrozen();
  const load = await prisma.load.findFirst({
    where: { id: loadId, workspaceId, deletedAt: null, status: "completed" },
    select: { id: true, vehicleId: true, completedAt: true, stops: { orderBy: { stopSequence: "asc" }, select: { id: true, lat: true, lng: true, timeWindowEarliest: true, timeWindowLatest: true, evidence: { select: { id: true, state: true, insideCount: true } } } } }
  });
  if (!load || !load.vehicleId || !load.completedAt) return out;
  const placed = load.stops.filter((s) => s.lat != null && s.lng != null);
  out.noCoordinates = load.stops.length - placed.length;
  if (placed.length === 0) return out;
  const span = trackWindow(placed.map((s) => ms(s.timeWindowEarliest)), load.completedAt.getTime());
  const pings = await prisma.vehiclePing.findMany({ where: { workspaceId, vehicleId: load.vehicleId, at: { gte: new Date(span.since), lte: new Date(span.until) } }, orderBy: { at: "asc" }, take: MAX_PINGS, select: { at: true, lat: true, lng: true } });
  const track: Fix[] = pings.map((p) => ({ at: p.at.getTime(), lat: numOrNull(p.lat)!, lng: numOrNull(p.lng)! }));
  // A truck with no fixes at all in the window has nothing to say about any stop. One that has fixes but never came near a stop gets a row that says so (quality none): that is evidence too, and it stops
  // the catch-up retrying.
  if (track.length === 0) {
    out.noFixes += placed.length;
    return out;
  }
  for (const s of placed) {
    const stop = { lat: numOrNull(s.lat)!, lng: numOrNull(s.lng)! };
    const kept = keepFixes(track, stop);
    const proposal = proposeStopEvidence(kept, { windowStart: ms(s.timeWindowEarliest), windowEnd: ms(s.timeWindowLatest) });
    const existing = s.evidence;
    if (existing && (existing.state !== "proposed" || proposal.inCount <= existing.insideCount)) {
      out.unchanged += 1;
      continue;
    }
    const data = {
      workspaceId,
      loadId: load.id,
      stopId: s.id,
      vehicleId: load.vehicleId,
      state: "proposed",
      quality: proposal.quality,
      radiusMiles: EVIDENCE_RADIUS_MILES,
      fixes: kept.map((f) => ({ at: f.at, lat: f.lat, lng: f.lng, miles: f.miles })) as Prisma.InputJsonValue,
      fixCount: proposal.fixCount,
      insideCount: proposal.inCount,
      windowStart: s.timeWindowEarliest,
      windowEnd: s.timeWindowLatest,
      proposedArrivalAt: when(proposal.arrivalAt),
      proposedDepartureAt: when(proposal.departureAt),
      beforeGapMin: proposal.beforeGapMin,
      afterGapMin: proposal.afterGapMin,
      stillInside: proposal.stillInside,
      visitCount: proposal.visits.length,
      waitFrom: when(proposal.waitFrom),
      proposedWaitMinutes: proposal.waitMinutes,
      sha256: sha(canonicalEvidence({ stopId: s.id, radiusMiles: EVIDENCE_RADIUS_MILES, windowStart: ms(s.timeWindowEarliest), windowEnd: ms(s.timeWindowLatest), fixes: kept, proposal })),
      frozenAt: now
    };
    if (existing) {
      await prisma.stopEvidence.update({ where: { id: existing.id }, data });
      out.improved += 1;
    } else {
      await prisma.stopEvidence.create({ data });
      out.created += 1;
    }
  }
  return out;
}

/**
 * Freezes the loads delivered in the last few days that have a placed stop with no evidence yet (a delivery entered late, or a truck whose fixes arrived after). Run before the fixes are deleted: the
 * partner heartbeat calls it ahead of its purge. With no `workspaceId` it covers every desk. A failed load is counted, never stops the others.
 */
export async function freezeRecentDeliveries(now = new Date(), workspaceId?: string): Promise<FreezeCounts & { loads: number; failed: number }> {
  const since = new Date(now.getTime() - CATCH_UP_DAYS * DAY);
  const ids = await prisma.$queryRaw<Array<{ id: string; workspace_id: string }>>`
    select l.id, l.workspace_id from loads l
    where l.status = 'completed' and l.deleted_at is null and l.vehicle_id is not null and l.completed_at >= ${since}${workspaceId ? Prisma.sql` and l.workspace_id = ${workspaceId}` : Prisma.empty}
      and exists (select 1 from stops s where s.load_id = l.id and s.lat is not null and s.lng is not null and not exists (select 1 from stop_evidence e where e.stop_id = s.id))
      and exists (select 1 from vehicle_pings p where p.vehicle_id = l.vehicle_id and p.at >= l.completed_at - interval '5 days' and p.at <= l.completed_at + interval '12 hours')
    order by l.completed_at desc limit ${CATCH_UP_LOADS}`;
  const total = { ...noneFrozen(), loads: 0, failed: 0 };
  for (const row of ids) {
    total.loads += 1;
    try {
      const c = await freezeEvidence(row.id, now, row.workspace_id);
      total.created += c.created;
      total.improved += c.improved;
      total.unchanged += c.unchanged;
      total.noCoordinates += c.noCoordinates;
      total.noFixes += c.noFixes;
    } catch {
      total.failed += 1;
    }
  }
  return total;
}

// ── Reading the pack ──────────────────────────────────────────────────────────────────────────────

export type EvidenceView = {
  id: string;
  state: "proposed" | "confirmed" | "dismissed";
  quality: Quality;
  radiusMiles: number;
  fixes: KeptFix[];
  fixCount: number;
  insideCount: number;
  visitCount: number;
  proposedArrivalAt: Date | null;
  proposedDepartureAt: Date | null;
  beforeGapMin: number | null;
  afterGapMin: number | null;
  stillInside: boolean;
  waitFrom: Date | null;
  proposedWaitMinutes: number | null;
  notes: string[];
  sha256: string;
  /** Whether the stored evidence still hashes to what was frozen. */
  intact: boolean;
  frozenAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  confirmedArrivalAt: Date | null;
  confirmedWaitMinutes: number | null;
  edited: boolean;
  wroteToStop: boolean;
  note: string | null;
  /** What the proposed wait is worth past the free time at the truck's rate; null with no wait or no rate. */
  worth: { billableMinutes: number; amount: number } | null;
};

export type PackStop = {
  stopId: string;
  sequence: number;
  role: string;
  label: string;
  address: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  /** What is entered on the stop now. */
  arrivedAt: Date | null;
  waitMinutes: number | null;
  placed: boolean;
  evidence: EvidenceView | null;
};

export type EvidencePack = {
  load: { id: string; loadNumber: string | null; customer: string | null; status: string; paymentStatus: string | null; truck: string | null; completedAt: Date | null; invoiced: boolean };
  terms: { ratePerHour: number | null; freeMinutes: number };
  tz: string;
  stops: PackStop[];
};

const roleOf = (s: { stopRole: string | null; stopType: string }) => s.stopRole ?? s.stopType;

/** One load's pack, for a person limited to `allowed` (null is everything): a load outside their terminals is not found. */
export async function getEvidencePack(loadId: string, workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<EvidencePack | null> {
  const limit = allowed === undefined ? await currentAllowed(workspaceId) : allowed;
  const load = await prisma.load.findFirst({
    where: { id: loadId, workspaceId, deletedAt: null, status: { in: ["completed", "in_progress"] }, AND: [inTerminal(limit)] },
    select: {
      id: true,
      loadNumber: true,
      brokerName: true,
      status: true,
      paymentStatus: true,
      completedAt: true,
      snapshotDetentionRate: true,
      snapshotFreeGraceMinutes: true,
      vehicle: { select: { name: true, costProfile: { select: { detentionHourlyRate: true, freeGraceMinutes: true } } } },
      stops: { orderBy: { stopSequence: "asc" }, include: { evidence: true } }
    }
  });
  if (!load) return null;
  const [thresholds, tz] = await Promise.all([getThresholds(workspaceId), workspaceTimezone(workspaceId)]);
  const rate = numOrNull(load.snapshotDetentionRate) ?? numOrNull(load.vehicle?.costProfile?.detentionHourlyRate);
  const free = load.snapshotFreeGraceMinutes ?? load.vehicle?.costProfile?.freeGraceMinutes ?? thresholds.detentionGraceMinutes;
  const stops: PackStop[] = load.stops.map((s) => {
    const e = s.evidence;
    let view: EvidenceView | null = null;
    if (e) {
      const fixes = fixesOf(e.fixes);
      const rebuilt = proposeStopEvidence(fixes, { windowStart: ms(e.windowStart), windowEnd: ms(e.windowEnd) }, numOrNull(e.radiusMiles) ?? EVIDENCE_RADIUS_MILES);
      const hash = sha(canonicalEvidence({ stopId: s.id, radiusMiles: numOrNull(e.radiusMiles) ?? EVIDENCE_RADIUS_MILES, windowStart: ms(e.windowStart), windowEnd: ms(e.windowEnd), fixes, proposal: { quality: e.quality as Quality, arrivalAt: ms(e.proposedArrivalAt), departureAt: ms(e.proposedDepartureAt), waitFrom: ms(e.waitFrom), waitMinutes: e.proposedWaitMinutes } }));
      view = {
        id: e.id,
        state: e.state as EvidenceView["state"],
        quality: e.quality as Quality,
        radiusMiles: numOrNull(e.radiusMiles) ?? EVIDENCE_RADIUS_MILES,
        fixes,
        fixCount: e.fixCount,
        insideCount: e.insideCount,
        visitCount: e.visitCount,
        proposedArrivalAt: e.proposedArrivalAt,
        proposedDepartureAt: e.proposedDepartureAt,
        beforeGapMin: e.beforeGapMin,
        afterGapMin: e.afterGapMin,
        stillInside: e.stillInside,
        waitFrom: e.waitFrom,
        proposedWaitMinutes: e.proposedWaitMinutes,
        notes: rebuilt.notes,
        sha256: e.sha256,
        intact: hash === e.sha256,
        frozenAt: e.frozenAt,
        decidedBy: e.decidedBy,
        decidedAt: e.decidedAt,
        confirmedArrivalAt: e.confirmedArrivalAt,
        confirmedWaitMinutes: e.confirmedWaitMinutes,
        edited: e.edited,
        wroteToStop: e.wroteToStop,
        note: e.note,
        worth: worthOf(e.proposedWaitMinutes, free, rate)
      };
    }
    return { stopId: s.id, sequence: s.stopSequence, role: roleOf(s), label: s.facilityName ?? s.addressString, address: s.addressString, windowStart: s.timeWindowEarliest, windowEnd: s.timeWindowLatest, arrivedAt: s.arrivedAt, waitMinutes: s.waitMinutes, placed: s.lat != null && s.lng != null, evidence: view };
  });
  return {
    load: { id: load.id, loadNumber: load.loadNumber, customer: load.brokerName, status: load.status, paymentStatus: load.paymentStatus, truck: load.vehicle?.name ?? null, completedAt: load.completedAt, invoiced: load.paymentStatus === "invoiced" || load.paymentStatus === "paid" },
    terms: { ratePerHour: rate, freeMinutes: free },
    tz,
    stops
  };
}

export type ProposedRow = { evidenceId: string; loadId: string; loadNumber: string | null; customer: string | null; stop: number; role: string; label: string; quality: Quality; proposedWaitMinutes: number; enteredWaitMinutes: number | null; amount: number; billableMinutes: number; frozenAt: Date };
export const PROPOSED_LIMIT = 50;

/**
 * Delivered stops where the truck's track shows a wait past the free time that nobody has confirmed (and that is longer than what was typed), newest first: detention the desk has not recorded. Only
 * loads in the person's terminals. A proposal is not a leak until a person confirms it, so none of this is in the Leak Ledger.
 */
export async function listProposed(terminal: Terminals = null, workspaceId = currentWorkspaceId(), limit = PROPOSED_LIMIT): Promise<ProposedRow[]> {
  const [thresholds] = await Promise.all([getThresholds(workspaceId)]);
  const rows = await prisma.stopEvidence.findMany({
    where: { workspaceId, state: "proposed", quality: { not: "none" }, proposedWaitMinutes: { gt: 0 }, load: { is: { deletedAt: null, status: "completed", AND: [inTerminal(terminal)] } } },
    orderBy: [{ frozenAt: "desc" }, { id: "desc" }],
    take: limit * 4,
    select: {
      id: true,
      loadId: true,
      proposedWaitMinutes: true,
      quality: true,
      frozenAt: true,
      stop: { select: { stopSequence: true, stopRole: true, stopType: true, facilityName: true, addressString: true, waitMinutes: true } },
      load: { select: { loadNumber: true, brokerName: true, snapshotDetentionRate: true, snapshotFreeGraceMinutes: true, vehicle: { select: { costProfile: { select: { detentionHourlyRate: true, freeGraceMinutes: true } } } } } }
    }
  });
  const out: ProposedRow[] = [];
  for (const r of rows) {
    const rate = numOrNull(r.load.snapshotDetentionRate) ?? numOrNull(r.load.vehicle?.costProfile?.detentionHourlyRate);
    const free = r.load.snapshotFreeGraceMinutes ?? r.load.vehicle?.costProfile?.freeGraceMinutes ?? thresholds.detentionGraceMinutes;
    const worth = worthOf(r.proposedWaitMinutes, free, rate);
    if (!worth || !(worth.amount > 0)) continue;
    // What was typed already covers it: nothing new to say.
    if ((r.stop.waitMinutes ?? 0) >= (r.proposedWaitMinutes ?? 0)) continue;
    out.push({ evidenceId: r.id, loadId: r.loadId, loadNumber: r.load.loadNumber, customer: r.load.brokerName, stop: r.stop.stopSequence, role: roleOf(r.stop), label: r.stop.facilityName ?? r.stop.addressString, quality: r.quality as Quality, proposedWaitMinutes: r.proposedWaitMinutes!, enteredWaitMinutes: r.stop.waitMinutes, amount: worth.amount, billableMinutes: worth.billableMinutes, frozenAt: r.frozenAt });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Deciding ──────────────────────────────────────────────────────────────────────────────────────

export type DecisionResult = { ok: true; changed: boolean } | { ok: false; error: string; errors?: Partial<Record<"arrivalAt" | "waitMinutes" | "note", string>> };
export type ConfirmValues = { arrivalAt?: string | null; waitMinutes?: string | null; note?: string | null; /** Keep the evidence as proof only: no stop is changed (for a load that is already invoiced). */ proofOnly?: boolean };

async function loadOf(evidenceId: string, workspaceId: string, allowed: Terminals | undefined) {
  const limit = allowed === undefined ? await currentAllowed(workspaceId) : allowed;
  const e = await prisma.stopEvidence.findFirst({ where: { id: evidenceId, workspaceId, load: { is: { deletedAt: null, AND: [inTerminal(limit)] } } }, include: { stop: true, load: { select: { id: true, loadNumber: true, paymentStatus: true } } } });
  return e;
}

const GONE: DecisionResult = { ok: false, error: "That evidence is no longer on the desk." };

/**
 * A person accepts what the truck's track showed, or corrects it with a few words on why. Unless it is kept as proof only, the stop's arrival and wait are then written through `correctTrip` (so a load that
 * has been invoiced refuses, in its own words, until the invoice is taken back). The evidence is marked decided once the stop is written, so a retry after a failure in between finishes the job.
 */
export async function confirmStopEvidence(evidenceId: string, values: ConfirmValues, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<DecisionResult> {
  const e = await loadOf(evidenceId, workspaceId, allowed);
  if (!e) return GONE;
  if (e.state !== "proposed") return { ok: false, error: e.state === "confirmed" ? "Already confirmed." : "That evidence was dismissed." };
  const arrival = values.arrivalAt === undefined ? undefined : values.arrivalAt === "" || values.arrivalAt == null ? null : Date.parse(values.arrivalAt);
  const wait = parseTypedMinutes(values.waitMinutes);
  const input: ConfirmInput = { arrivalAt: arrival, waitMinutes: wait, note: values.note ?? null };
  const check = checkConfirmation({ arrivalAt: ms(e.proposedArrivalAt), waitMinutes: e.proposedWaitMinutes }, input);
  if (!check.ok) return { ok: false, error: "Check the figures.", errors: check.errors };

  let wrote = false;
  if (!values.proofOnly) {
    const clocks = await stopClocksOf(e.loadId, workspaceId);
    const zone = clocks.find((c) => c.id === e.stopId)?.zone ?? (await workspaceTimezone(workspaceId));
    const r = await correctTrip(e.loadId, { stops: [{ id: e.stopId, arrivedAt: check.arrivalAt == null ? "" : toCentralLocal(check.arrivalAt, zone), waitMinutes: String(check.waitMinutes), seal: e.stop.sealNumber ?? "", zone }], reason: `Detention evidence confirmed${check.edited ? " (edited)" : ""}${check.note ? `: ${check.note}` : ""}` }, now, workspaceId);
    if (!r.ok) {
      const first = "errors" in r && r.errors ? Object.values(r.errors)[0] : null;
      return { ok: false, error: (("error" in r && r.error) || first || "The stop could not be corrected.") + (e.load.paymentStatus ? " You can confirm it as proof only, which changes nothing on the load." : "") };
    }
    wrote = true;
  }
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.stopEvidence.updateMany({ where: { id: e.id, state: "proposed" }, data: { state: "confirmed", decidedBy: currentActor(), decidedAt: now, confirmedArrivalAt: when(check.arrivalAt), confirmedWaitMinutes: check.waitMinutes, edited: check.edited, wroteToStop: wrote, note: check.note } });
    if (claimed.count !== 1) return;
    await recordAudit(
      {
        entity: "load",
        entityId: e.id,
        action: "detention_evidence_confirmed",
        loadId: e.loadId,
        loadNumber: e.load.loadNumber,
        summary: `Detention evidence confirmed for stop ${e.stop.stopSequence}: ${check.waitMinutes} min${check.edited ? " (edited)" : ""}${wrote ? "" : ", kept as proof only"}`,
        reason: check.note,
        before: { Proposed: e.proposedWaitMinutes != null ? `${e.proposedWaitMinutes} min` : "No wait read", Arrival: e.proposedArrivalAt ? dateTime(e.proposedArrivalAt) : null },
        after: { Confirmed: `${check.waitMinutes} min`, Arrival: check.arrivalAt != null ? dateTime(new Date(check.arrivalAt)) : null, "Written to the stop": wrote ? "Yes" : "No" },
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true, changed: true };
}

/** A person says the track does not show a wait worth claiming, with the reason. Writes nothing to the stop. */
export async function dismissStopEvidence(evidenceId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<DecisionResult> {
  const e = await loadOf(evidenceId, workspaceId, allowed);
  if (!e) return GONE;
  if (e.state !== "proposed") return { ok: false, error: e.state === "confirmed" ? "Already confirmed." : "Already dismissed." };
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why it is not being claimed.", errors: { note: "Say why it is not being claimed." } };
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.stopEvidence.updateMany({ where: { id: e.id, state: "proposed" }, data: { state: "dismissed", decidedBy: currentActor(), decidedAt: now, note: why } });
    if (claimed.count !== 1) return;
    await recordAudit({ entity: "load", entityId: e.id, action: "detention_evidence_dismissed", loadId: e.loadId, loadNumber: e.load.loadNumber, summary: `Detention evidence dismissed for stop ${e.stop.stopSequence}`, reason: why, before: { Proposed: e.proposedWaitMinutes != null ? `${e.proposedWaitMinutes} min` : "No wait read" }, after: { Evidence: "Dismissed" }, at: now, workspaceId }, tx);
  });
  return { ok: true, changed: true };
}

/** How many of a load's stops have frozen evidence, and how many still wait for a person: the cockpit's one line. */
export async function evidenceSummary(loadId: string, workspaceId = currentWorkspaceId()): Promise<{ total: number; proposed: number }> {
  const rows = await prisma.stopEvidence.groupBy({ by: ["state"], where: { workspaceId, loadId, quality: { not: "none" } }, _count: { _all: true } });
  const total = rows.reduce((s, r) => s + r._count._all, 0);
  return { total, proposed: rows.find((r) => r.state === "proposed")?._count._all ?? 0 };
}
