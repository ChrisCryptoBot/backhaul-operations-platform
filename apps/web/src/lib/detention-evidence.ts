import { haversineMiles } from "./geo";
import { computeBillableDetention } from "@/truelane/lib/domain/detention";

/**
 * The detention evidence pack's rules (docs/DETENTION_EVIDENCE.md). From the ELD's position fixes near one stop, what the truck's own track supports: when it was first seen at the facility, when it was last
 * seen there, and so how long it sat. Conservative by construction: a proposal never claims more than the fixes show. Arrival is the FIRST fix inside the radius and departure the LAST fix inside (the truck
 * may have come earlier and left later, and the uncertainty is kept as the gap to the neighbouring fix outside), so a claim built on it is never larger than what the track can prove. A proposal changes nothing:
 * a person confirms it (server/tl/detention-evidence.ts). Pure: fixes and a stop in, plain data out.
 */
export type Fix = { at: number; lat: number; lng: number };
export type KeptFix = Fix & { miles: number };

export type StopPoint = { lat: number; lng: number; windowStart: number | null; windowEnd: number | null };

/** Inside this many miles of a stop is "at the facility" for evidence: a dock or a yard, not the next exit. (The Where-it-is tab keeps its own, wider mile.) */
export const EVIDENCE_RADIUS_MILES = 0.25;
/** The fixes this near a stop are kept with the evidence, so the proof outlives the week the fixes are kept. */
export const KEEP_FIX_MILES = 2;
export const MAX_FIXES = 200;
/** Two stretches inside the radius with the truck seen outside between them and no more than this apart are one visit (a truck pulled forward, or round the block). */
export const SAME_VISIT_MINUTES = 30;
/** A gap this long or less between a fix outside and the first one inside (or the last one inside and the next one outside) leaves the time well pinned. */
export const GOOD_GAP_MINUTES = 20;
export const MIN_INSIDE_FIXES = 3;

const MIN = 60_000;

/** The fixes within `KEEP_FIX_MILES` of the stop, oldest first, with their distance. More than `MAX_FIXES` are thinned evenly, always keeping the ones that decide the visit (the first and last inside and their neighbours). */
export function keepFixes(fixes: readonly Fix[], stop: Pick<StopPoint, "lat" | "lng">, radius = EVIDENCE_RADIUS_MILES): KeptFix[] {
  const near = fixes
    .map((f) => ({ ...f, miles: haversineMiles({ lat: f.lat, lng: f.lng }, stop) }))
    .filter((f) => f.miles <= KEEP_FIX_MILES)
    .sort((a, b) => a.at - b.at);
  if (near.length <= MAX_FIXES) return near;
  const protect = new Set<number>();
  const inside = near.map((f, i) => (f.miles <= radius ? i : -1)).filter((i) => i >= 0);
  const first = inside[0];
  const last = inside[inside.length - 1];
  for (const i of [first, last]) if (i != null) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < near.length) protect.add(j);
  protect.add(0);
  protect.add(near.length - 1);
  const room = Math.max(0, MAX_FIXES - protect.size);
  const rest = near.map((_, i) => i).filter((i) => !protect.has(i));
  const step = rest.length / Math.max(1, room);
  const pick = new Set<number>(protect);
  for (let k = 0; k < room && k * step < rest.length; k++) pick.add(rest[Math.floor(k * step)]!);
  return near.filter((_, i) => pick.has(i));
}

export type Quality = "good" | "thin" | "none";

export type Visit = { firstIn: number; lastIn: number; inCount: number };

export type Proposal = {
  quality: Quality;
  radiusMiles: number;
  /** The fixes kept (within two miles), and how many of them were inside the radius. */
  fixCount: number;
  inCount: number;
  /** Every separate visit seen, in order. Only the first is proposed. */
  visits: Visit[];
  arrivalAt: number | null;
  departureAt: number | null;
  /** Minutes between the last fix outside before the arrival and the arrival (null when there is no earlier fix: the track starts with the truck already there). */
  beforeGapMin: number | null;
  /** Minutes between the departure and the next fix outside (null while the truck was still inside when the track ended). */
  afterGapMin: number | null;
  /** The truck was still inside at the last fix, so there is no departure to read. */
  stillInside: boolean;
  /** When the wait is counted from: the later of the arrival and the appointment window's start. */
  waitFrom: number | null;
  /** Whole minutes from `waitFrom` to the departure, never below zero; null with no departure. */
  waitMinutes: number | null;
  notes: string[];
};

const minutes = (a: number, b: number): number => Math.round((b - a) / MIN);

/** What a stop's track supports. `fixes` must be the kept ones (oldest first). */
export function proposeStopEvidence(fixes: readonly KeptFix[], stop: Pick<StopPoint, "windowStart" | "windowEnd">, radius = EVIDENCE_RADIUS_MILES): Proposal {
  const sorted = [...fixes].sort((a, b) => a.at - b.at);
  const inside = (f: KeptFix) => f.miles <= radius;
  const base: Proposal = { quality: "none", radiusMiles: radius, fixCount: sorted.length, inCount: sorted.filter(inside).length, visits: [], arrivalAt: null, departureAt: null, beforeGapMin: null, afterGapMin: null, stillInside: false, waitFrom: null, waitMinutes: null, notes: [] };
  if (base.inCount === 0) return { ...base, notes: [sorted.length === 0 ? "No position fix was kept near this stop." : `The truck was seen within ${KEEP_FIX_MILES} miles but never within ${radius} mile of the stop.`] };

  // Visits: runs of fixes inside, joined when the truck was seen outside in between for no more than SAME_VISIT_MINUTES.
  const visits: Array<Visit & { startIdx: number; endIdx: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    if (!inside(sorted[i]!)) continue;
    const prev = visits[visits.length - 1];
    if (prev) {
      const between = sorted.slice(prev.endIdx + 1, i);
      const wentOut = between.some((f) => !inside(f));
      const apart = minutes(sorted[prev.endIdx]!.at, sorted[i]!.at);
      if (!wentOut || apart <= SAME_VISIT_MINUTES) {
        prev.lastIn = sorted[i]!.at;
        prev.endIdx = i;
        prev.inCount += 1;
        continue;
      }
    }
    visits.push({ firstIn: sorted[i]!.at, lastIn: sorted[i]!.at, inCount: 1, startIdx: i, endIdx: i });
  }
  const v = visits[0]!;
  const beforeFix = v.startIdx > 0 ? sorted[v.startIdx - 1]! : null;
  const afterFix = v.endIdx < sorted.length - 1 ? sorted[v.endIdx + 1]! : null;
  // A fix after the visit that is itself inside belongs to a later visit; the first visit ends at the next fix, whatever it is.
  const beforeGapMin = beforeFix ? minutes(beforeFix.at, v.firstIn) : null;
  const afterGapMin = afterFix ? minutes(v.lastIn, afterFix.at) : null;
  const stillInside = afterFix == null;
  const arrivalAt = v.firstIn;
  const departureAt = stillInside ? null : v.lastIn;
  const waitFrom = stop.windowStart != null ? Math.max(arrivalAt, stop.windowStart) : arrivalAt;
  const waitMinutes = departureAt == null ? null : Math.max(0, Math.floor((departureAt - waitFrom) / MIN));
  const notes: string[] = [];
  if (beforeGapMin == null) notes.push("The track starts with the truck already at the facility, so its arrival may have been earlier.");
  else notes.push(`Arrival is the first fix inside; the truck was last seen outside ${beforeGapMin} min before it.`);
  if (stillInside) notes.push("The truck was still at the facility at the last fix kept, so there is no departure to read.");
  else notes.push(`Departure is the last fix inside; the next fix, outside, came ${afterGapMin} min later.`);
  if (stop.windowStart != null && arrivalAt < stop.windowStart) notes.push("The truck arrived before the appointment window opened, so the wait is counted from the window's start.");
  if (visits.length > 1) notes.push(`The truck came back: ${visits.length} separate visits were seen. Only the first is proposed.`);
  const good = v.inCount >= MIN_INSIDE_FIXES && beforeGapMin != null && beforeGapMin <= GOOD_GAP_MINUTES && (stillInside || (afterGapMin != null && afterGapMin <= GOOD_GAP_MINUTES));
  if (v.inCount < MIN_INSIDE_FIXES) notes.push(`Only ${v.inCount} ${v.inCount === 1 ? "fix was" : "fixes were"} inside: too few to rely on.`);
  return {
    ...base,
    quality: good ? "good" : "thin",
    visits: visits.map(({ firstIn, lastIn, inCount }) => ({ firstIn, lastIn, inCount })),
    arrivalAt,
    departureAt,
    beforeGapMin,
    afterGapMin,
    stillInside,
    waitFrom,
    waitMinutes,
    notes
  };
}

/** What a wait is worth past the free time at the truck's rate: the invoice's own rule (src/truelane/lib/domain/detention.ts), so the sheet and the invoice agree. */
export function worthOf(waitMinutes: number | null, freeMinutes: number | null, ratePerHour: number | null): { billableMinutes: number; amount: number } | null {
  if (waitMinutes == null || ratePerHour == null || !(ratePerHour > 0)) return null;
  const r = computeBillableDetention({ dockWaitMinutes: waitMinutes, detentionHourlyRate: ratePerHour, freeGraceMinutes: freeMinutes ?? undefined });
  return { billableMinutes: r.billableMinutes, amount: r.billableAmount };
}

/** The evidence as one stable string (fixed key order, fixed number forms), so its hash says whether it was edited. */
export function canonicalEvidence(i: { stopId: string; radiusMiles: number; windowStart: number | null; windowEnd: number | null; fixes: readonly KeptFix[]; proposal: Pick<Proposal, "arrivalAt" | "departureAt" | "waitFrom" | "waitMinutes" | "quality"> }): string {
  const r = (n: number) => n.toFixed(6);
  return JSON.stringify({
    stop: i.stopId,
    radius: i.radiusMiles,
    window: [i.windowStart, i.windowEnd],
    proposal: [i.proposal.quality, i.proposal.arrivalAt, i.proposal.departureAt, i.proposal.waitFrom, i.proposal.waitMinutes],
    fixes: i.fixes.map((f) => [f.at, r(f.lat), r(f.lng), f.miles.toFixed(4)])
  });
}

export const MAX_WAIT_MINUTES = 10_080;

export type ConfirmInput = { arrivalAt?: number | null; waitMinutes?: number | null; note?: string | null };
export type ConfirmCheck = { ok: true; arrivalAt: number | null; waitMinutes: number; edited: boolean; note: string | null } | { ok: false; errors: Partial<Record<"arrivalAt" | "waitMinutes" | "note", string>> };

/**
 * What a person may confirm. Accepting the proposal as it is needs nothing more; changing the arrival or the wait (or confirming where the proposal has no wait) needs a few words on why, which are
 * kept with the evidence. The wait is whole minutes, up to a week.
 */
export function checkConfirmation(p: Pick<Proposal, "arrivalAt" | "waitMinutes">, input: ConfirmInput): ConfirmCheck {
  const errors: Partial<Record<"arrivalAt" | "waitMinutes" | "note", string>> = {};
  const note = (input.note ?? "").trim();
  const arrival = input.arrivalAt === undefined ? p.arrivalAt : input.arrivalAt;
  const wait = input.waitMinutes === undefined || input.waitMinutes === null ? p.waitMinutes : input.waitMinutes;
  if (wait == null) errors.waitMinutes = "The truck's track has no departure, so say how long it waited.";
  else if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_MINUTES) errors.waitMinutes = "Whole minutes, between 0 and 10,080.";
  if (arrival != null && !Number.isFinite(arrival)) errors.arrivalAt = "That is not a time.";
  const edited = wait !== p.waitMinutes || arrival !== p.arrivalAt;
  if (edited && note.length < 3) errors.note = "Say why it differs from what the truck's track showed.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, arrivalAt: arrival ?? null, waitMinutes: wait!, edited, note: note === "" ? null : note };
}

export const QUALITY_WORDS: Record<Quality, string> = { good: "Good: the truck was seen close to its arrival and its departure.", thin: "Thin: the track leaves gaps around the arrival or the departure, or has few fixes. Treat the times as approximate.", none: "None: the truck was not seen at the facility." };

const LOOK_BACK_MS = 5 * 86_400_000;
const LOOK_AFTER_MS = 12 * 3_600_000;
const BEFORE_WINDOW_MS = 12 * 3_600_000;

/** The stretch of the truck's track worth reading for a delivered load: from twelve hours before the first appointment (never more than five days before the delivery) to twelve hours after it. */
export function trackWindow(windowStarts: ReadonlyArray<number | null>, deliveredAt: number): { since: number; until: number } {
  const first = Math.min(deliveredAt, ...windowStarts.map((w) => w ?? deliveredAt));
  return { since: Math.max(deliveredAt - LOOK_BACK_MS, first - BEFORE_WINDOW_MS), until: deliveredAt + LOOK_AFTER_MS };
}

/** What a person typed for minutes: undefined when blank, NaN when it is not a number (the check refuses it), else the number. */
export function parseTypedMinutes(text: string | null | undefined): number | undefined {
  const t = (text ?? "").trim();
  return t === "" ? undefined : Number(t);
}
