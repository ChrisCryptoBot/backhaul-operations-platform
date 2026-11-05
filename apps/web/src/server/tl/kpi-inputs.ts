import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addDaysKey, dateKeyOf, weekdayOf } from "@/lib/shifts";
import { recordAudit } from "./audit";
import { currentActor } from "./identity";
import { clearKpiCache } from "./kpi";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * The two things a person types on the KPI screens: a lane's target rate per load (the Lanes scorecard compares each lane with it), and the note for the weekly call. Both are the workspace's own,
 * both are audited, and both change what a kept KPI answer is built from, so the kept answers are dropped.
 */
export type InputResult = { ok: true; changed: boolean } | { ok: false; error: string };

const MAX_RATE = 1_000_000;
const MAX_NOTE = 4000;

/** The Monday (YYYY-MM-DD) of the week an instant falls in, on the workspace's clock: the key of that week's note. */
export function weekKeyOf(ms: number, tz: string): string {
  const day = dateKeyOf(ms, tz);
  const back = (weekdayOf(day) + 6) % 7; // Sunday is 0; Monday starts the week
  return addDaysKey(day, -back);
}

/** Set a lane's target rate per load, or take it away (null or 0). */
export async function setLaneTarget(laneInput: string, rateInput: unknown, now = new Date(), workspaceId = currentWorkspaceId()): Promise<InputResult> {
  const lane = laneInput.trim();
  if (!lane || lane.length > 200) return { ok: false, error: "Pick a lane." };
  const text = rateInput == null ? "" : String(rateInput).replace(/[$,\s]/g, "");
  let rate: Prisma.Decimal | null = null;
  if (text !== "") {
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: "Type the target as dollars per load, such as 1500 or 1500.50." };
    rate = new Prisma.Decimal(text);
    if (rate.gt(MAX_RATE)) return { ok: false, error: "That target is too large." };
    if (rate.isZero()) rate = null;
  }
  const was = await prisma.laneTarget.findUnique({ where: { workspaceId_lane: { workspaceId, lane } } });
  const wasText = was ? new Prisma.Decimal(was.targetRate).toFixed(2) : null;
  const nowText = rate ? rate.toFixed(2) : null;
  if (wasText === nowText) return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    if (rate) await tx.laneTarget.upsert({ where: { workspaceId_lane: { workspaceId, lane } }, create: { workspaceId, lane, targetRate: rate, setBy: currentActor() }, update: { targetRate: rate, setBy: currentActor() } });
    else await tx.laneTarget.delete({ where: { workspaceId_lane: { workspaceId, lane } } });
    await recordAudit({ entity: "settings", action: "lane_target_set", summary: rate ? `${lane}: target ${nowText} a load` : `${lane}: target taken away`, before: { Lane: lane, Target: wasText }, after: { Lane: lane, Target: nowText }, at: now, workspaceId }, tx);
  });
  clearKpiCache();
  return { ok: true, changed: true };
}

export async function getKpiNote(weekKey: string, workspaceId = currentWorkspaceId()): Promise<{ body: string; updatedBy: string | null; updatedAt: Date } | null> {
  const n = await prisma.kpiNote.findUnique({ where: { workspaceId_weekKey: { workspaceId, weekKey } } });
  return n ? { body: n.body, updatedBy: n.updatedBy, updatedAt: n.updatedAt } : null;
}

/** Save the note for a week (an empty note takes it away). */
export async function saveKpiNote(weekKeyInput: string, bodyInput: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<InputResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKeyInput)) return { ok: false, error: "Pick a week." };
  const body = bodyInput.replace(/\r\n/g, "\n").trim();
  if (body.length > MAX_NOTE) return { ok: false, error: `Keep the note under ${MAX_NOTE.toLocaleString("en-US")} characters.` };
  const was = await prisma.kpiNote.findUnique({ where: { workspaceId_weekKey: { workspaceId, weekKey: weekKeyInput } } });
  if ((was?.body ?? "") === body) return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    if (body) await tx.kpiNote.upsert({ where: { workspaceId_weekKey: { workspaceId, weekKey: weekKeyInput } }, create: { workspaceId, weekKey: weekKeyInput, body, updatedBy: currentActor() }, update: { body, updatedBy: currentActor() } });
    else await tx.kpiNote.delete({ where: { workspaceId_weekKey: { workspaceId, weekKey: weekKeyInput } } });
    await recordAudit({ entity: "settings", action: "kpi_note_saved", summary: body ? `Notes for the call, week of ${weekKeyInput}, saved` : `Notes for the call, week of ${weekKeyInput}, cleared`, before: { Note: was?.body ?? null }, after: { Note: body || null }, at: now, workspaceId }, tx);
  });
  return { ok: true, changed: true };
}

export { workspaceTimezone };
