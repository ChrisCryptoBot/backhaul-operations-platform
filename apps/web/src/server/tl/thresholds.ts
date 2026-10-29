import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveThresholds, THRESHOLD_FIELDS, validateThresholds, type ThresholdCheck, type ThresholdRow, type Thresholds } from "@/lib/thresholds";
import { recordAudit } from "./audit";
import { numOrNull } from "./convert";
import { currentWorkspace, DEMO_WORKSPACE_ID } from "./workspace";

type StoredColumns = {
  emptyAmberPct: Prisma.Decimal | null;
  emptyRedPct: Prisma.Decimal | null;
  defaultPayTermsDays: number | null;
  detentionGraceMinutes: number | null;
  alertPickupHours: number | null;
  alertSentHours: number | null;
  alertClearanceDays: number | null;
};

/** The workspace's stored columns as the thresholds' own keys (the alert columns are named for the screen they belong to). */
function toRow(ws: StoredColumns): ThresholdRow {
  return {
    emptyAmberPct: numOrNull(ws.emptyAmberPct),
    emptyRedPct: numOrNull(ws.emptyRedPct),
    defaultPayTermsDays: ws.defaultPayTermsDays,
    detentionGraceMinutes: ws.detentionGraceMinutes,
    pickupAlertHours: ws.alertPickupHours,
    sentNoAnswerHours: ws.alertSentHours,
    clearanceDays: ws.alertClearanceDays
  };
}

/** What is stored, with null for "use the default" (the Settings form shows blanks for these). */
export async function getStoredThresholds(workspaceId = DEMO_WORKSPACE_ID): Promise<ThresholdRow> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  return ws ? toRow(ws) : {};
}

export async function getThresholds(workspaceId = DEMO_WORKSPACE_ID): Promise<Thresholds> {
  return resolveThresholds(await getStoredThresholds(workspaceId));
}

const fieldLabel = (key: keyof Thresholds) => {
  const f = THRESHOLD_FIELDS.find((x) => x.key === key)!;
  return `${f.label} (${f.unit})`;
};

/**
 * Checks and saves the thresholds. The audit event lists each value before and after; saving what is already stored writes
 * nothing. Returns the check, so the Settings form can show each field's message.
 */
export async function saveThresholds(input: Record<string, unknown>, now = new Date()): Promise<(ThresholdCheck & { changed?: boolean })> {
  const check = validateThresholds(input);
  if (!check.ok) return check;
  const ws = await currentWorkspace();
  const before = resolveThresholds(toRow(ws));
  const beforeStored = toRow(ws);
  const keys = Object.keys(check.stored) as Array<keyof Thresholds>;
  const differs = keys.filter((k) => (beforeStored[k] ?? null) !== check.stored[k]);
  if (differs.length === 0) return { ...check, changed: false };

  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({
      where: { id: ws.id },
      data: {
        emptyAmberPct: check.stored.emptyAmberPct,
        emptyRedPct: check.stored.emptyRedPct,
        defaultPayTermsDays: check.stored.defaultPayTermsDays,
        detentionGraceMinutes: check.stored.detentionGraceMinutes,
        alertPickupHours: check.stored.pickupAlertHours,
        alertSentHours: check.stored.sentNoAnswerHours,
        alertClearanceDays: check.stored.clearanceDays
      }
    });
    const shown = (t: Thresholds, only: Array<keyof Thresholds>) => Object.fromEntries(only.map((k) => [fieldLabel(k), t[k]]));
    const moved = differs.filter((k) => before[k] !== check.resolved[k]);
    await recordAudit(
      {
        entity: "settings",
        action: "thresholds_changed",
        summary: moved.length > 0 ? `Changed ${moved.map((k) => fieldLabel(k).replace(/ \(.*\)$/, "").toLowerCase()).join(", ")}` : "Reset to the defaults",
        before: shown(before, moved.length > 0 ? moved : differs),
        after: shown(check.resolved, moved.length > 0 ? moved : differs),
        at: now,
        workspaceId: ws.id
      },
      tx
    );
  });
  return { ...check, changed: true };
}
