import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { dwell, type DwellOverride } from "@/lib/telematics";
import { recordAudit } from "./audit";
import { numOrNull } from "./convert";
import { currentActor } from "./identity";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";

/**
 * A dropped trailer's dwell figure belongs to the company, and the company's people make the call: a dispatcher or a billing person can type the rate a day, type the billable days, or waive the
 * whole fee, on any one trailer. The company's thresholds (Settings, Rules) are only the starting point, and a typed figure always beats them. It stands for that stay: a later recompute only changes
 * the computed figure beside it, and hooking the trailer again clears it (hookTrailer). Every change is audited with the figures before and after and who made it.
 */
export type DwellResult = { ok: true } | { ok: false; error: string };
export type DwellInput = { ratePerDay?: string | number | null; billableDays?: string | number | null; note?: string | null };

export const MAX_DWELL_RATE = 1000;
export const MAX_DWELL_DAYS = 365;

const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

/** A typed figure with at most two decimals between 0 and `max`, or the problem in words. Blank is "no figure" (null). */
function figure(raw: unknown, max: number, what: string): { ok: true; value: Prisma.Decimal | null } | { ok: false; error: string } {
  if (blank(raw)) return { ok: true, value: null };
  const text = String(raw).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: `${what}: type a number with at most two decimals.` };
  const d = new Prisma.Decimal(text);
  if (d.gt(max)) return { ok: false, error: `${what}: no more than ${max}.` };
  return { ok: true, value: d };
}

const owed = (n: number) => `$${n.toFixed(2)}`;

type Row = Prisma.TrailerGetPayload<{ select: { id: true; number: true; unhookedAt: true; dwellRateOverride: true; dwellDaysOverride: true; dwellWaived: true; dwellOverrideNote: true } }>;

const overrideOf = (t: Pick<Row, "dwellRateOverride" | "dwellDaysOverride" | "dwellWaived">): DwellOverride => ({ ratePerDay: numOrNull(t.dwellRateOverride), billableDays: numOrNull(t.dwellDaysOverride), waived: t.dwellWaived });

async function load(id: string, workspaceId: string): Promise<{ row: Row } | { error: string }> {
  const row = await prisma.trailer.findFirst({
    where: { id, workspaceId, archivedAt: null },
    select: { id: true, number: true, unhookedAt: true, dwellRateOverride: true, dwellDaysOverride: true, dwellWaived: true, dwellOverrideNote: true }
  });
  if (!row) return { error: "That trailer is not available." };
  if (!row.unhookedAt) return { error: `${row.number} is hooked to a tractor, so it is not dwelling.` };
  return { row };
}

const snapshot = (o: DwellOverride, amount: number) => ({ "Rate a day": o.ratePerDay == null ? "Company rate" : owed(o.ratePerDay), "Billable days": o.billableDays == null ? "Company count" : String(o.billableDays), Waived: o.waived ? "Yes" : "No", Owed: owed(amount) });

async function save(row: Row, next: { rate: Prisma.Decimal | null; days: Prisma.Decimal | null; waived: boolean; note: string | null }, action: "dwell_adjusted" | "dwell_waived" | "dwell_reset", verb: string, now: Date, workspaceId: string): Promise<DwellResult> {
  const terms = await getThresholds(workspaceId);
  const t = { freeHours: terms.dwellFreeHours, perDay: terms.dwellPerDayRate };
  const before = overrideOf(row);
  const after: DwellOverride = { ratePerDay: next.rate?.toNumber() ?? null, billableDays: next.days?.toNumber() ?? null, waived: next.waived };
  const reset = action === "dwell_reset";
  const was = dwell(row.unhookedAt, now.getTime(), t, false, before)!;
  const will = dwell(row.unhookedAt, now.getTime(), t, false, after)!;
  const by = reset ? null : currentActor();
  await prisma.$transaction(async (tx) => {
    await tx.trailer.update({
      where: { id: row.id },
      data: { dwellRateOverride: next.rate, dwellDaysOverride: next.days, dwellWaived: next.waived, dwellOverrideNote: reset ? null : next.note, dwellOverrideBy: by, dwellOverrideAt: reset ? null : now }
    });
    await recordAudit(
      {
        entity: "trailer",
        entityId: row.id,
        action,
        summary: `${row.number}: ${verb} (${owed(was.amount)} to ${owed(will.amount)})`,
        reason: next.note,
        before: snapshot(before, was.amount),
        after: snapshot(after, will.amount),
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true };
}

/** Type the rate a day and/or the billable days for this stay. Either may be left blank (it then follows the company's figure); at least one is needed. Adjusting lifts a waiver. */
export async function adjustTrailerDwell(trailerId: string, input: DwellInput, now = new Date(), workspaceId = currentWorkspaceId()): Promise<DwellResult> {
  const rate = figure(input.ratePerDay, MAX_DWELL_RATE, "Rate a day");
  if (!rate.ok) return rate;
  const days = figure(input.billableDays, MAX_DWELL_DAYS, "Billable days");
  if (!days.ok) return days;
  if (rate.value == null && days.value == null) return { ok: false, error: "Type a rate a day, the billable days, or both. To drop the fee entirely, waive it." };
  const got = await load(trailerId, workspaceId);
  if ("error" in got) return { ok: false, error: got.error };
  const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
  return save(got.row, { rate: rate.value, days: days.value, waived: false, note }, "dwell_adjusted", "dwell figure typed", now, workspaceId);
}

/** Waive the whole fee for this stay. A typed rate or days stay on the trailer (so the figure it would have been is still shown), and the fee owed is nothing. */
export async function waiveTrailerDwell(trailerId: string, note: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<DwellResult> {
  const got = await load(trailerId, workspaceId);
  if ("error" in got) return { ok: false, error: got.error };
  if (got.row.dwellWaived) return { ok: false, error: `The dwell fee on ${got.row.number} is already waived.` };
  const text = note?.trim() ? note.trim().slice(0, 200) : null;
  return save(got.row, { rate: got.row.dwellRateOverride, days: got.row.dwellDaysOverride, waived: true, note: text }, "dwell_waived", "dwell fee waived", now, workspaceId);
}

/** Back to the company's figure: every typed value and the waiver are cleared. */
export async function clearTrailerDwell(trailerId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<DwellResult> {
  const got = await load(trailerId, workspaceId);
  if ("error" in got) return { ok: false, error: got.error };
  const r = got.row;
  if (!r.dwellWaived && r.dwellRateOverride == null && r.dwellDaysOverride == null) return { ok: true };
  return save(r, { rate: null, days: null, waived: false, note: null }, "dwell_reset", "back to the company figure", now, workspaceId);
}
