import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface KpiAlert {
  id: string;
  code: string;
  severity: "INFO" | "WARN" | "ACTION_REQUIRED";
  title: string;
  message: string;
  lane?: string;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
}

function parseDecimal(value: string | number | null): Prisma.Decimal | null {
  if (value === null) return null;
  try {
    return new Prisma.Decimal(value);
  } catch {
    return null;
  }
}

/** Default aggregate empty-mile alert threshold (whole percent) when no region config is supplied. */
export const DEFAULT_EMPTY_MILE_ALERT_THRESHOLD = 6.5;

export function evaluateKpiAlerts(input: {
  weekIso: string;
  lanes: Array<{ lane: string; vsTarget: string | number | null; emptyPct: string | number | null }>;
  cards: Array<{ key: string; value: string | number }>;
  /** Aggregate empty-mile % that fires the alert (whole percent). Defaults to 6.5. */
  emptyPctAlert?: number | null;
}): KpiAlert[] {
  const alerts: KpiAlert[] = [];
  const threshold = new Prisma.Decimal(
    input.emptyPctAlert != null && Number.isFinite(input.emptyPctAlert)
      ? input.emptyPctAlert
      : DEFAULT_EMPTY_MILE_ALERT_THRESHOLD
  );
  const emptyCard = input.cards.find((card) => card.key === "emptyPct");
  const emptyPct = parseDecimal(emptyCard ? emptyCard.value : null);
  if (emptyPct && emptyPct.greaterThan(threshold)) {
    alerts.push({
      id: `${input.weekIso}:empty-mile`,
      code: "EMPTY_MILE_THRESHOLD",
      severity: "WARN",
      title: "Empty mile threshold exceeded",
      message: `Empty mile percentage is ${emptyPct.toFixed(1)}%, above the ${threshold.toFixed(1)}% threshold.`
    });
  }

  for (const lane of input.lanes) {
    const vsTarget = parseDecimal(lane.vsTarget);
    if (vsTarget && vsTarget.lessThan("-100")) {
      alerts.push({
        id: `${input.weekIso}:lane:${lane.lane}`,
        code: "LANE_BELOW_FLOOR",
        severity: "ACTION_REQUIRED",
        title: "Lane below target",
        message: `${lane.lane} is currently ${vsTarget.abs().toFixed(0)} below target.`,
        lane: lane.lane
      });
    }
  }

  return alerts;
}

export async function hydrateAlertAcknowledgements(alerts: KpiAlert[]): Promise<KpiAlert[]> {
  if (alerts.length === 0) return alerts;
  try {
    const entityIds = alerts.map((alert) => alert.id);
    const rows = await prisma.auditLog.findMany({
      where: {
        entityType: "KPI_ALERT",
        entityId: { in: entityIds },
        action: "ACKNOWLEDGED"
      },
      orderBy: { timestamp: "desc" }
    });
    const byId = new Map<string, { acknowledgedAt: string; acknowledgedBy: string }>();
    for (const row of rows) {
      if (!byId.has(row.entityId)) {
        byId.set(row.entityId, {
          acknowledgedAt: row.timestamp.toISOString(),
          acknowledgedBy: row.actorId
        });
      }
    }
    return alerts.map((alert) => ({
      ...alert,
      acknowledgedAt: byId.get(alert.id)?.acknowledgedAt ?? null,
      acknowledgedBy: byId.get(alert.id)?.acknowledgedBy ?? null
    }));
  } catch {
    return alerts.map((alert) => ({
      ...alert,
      acknowledgedAt: null,
      acknowledgedBy: null
    }));
  }
}

export async function acknowledgeKpiAlert(input: {
  alertId: string;
  actorId: string;
  reason?: string;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      entityType: "KPI_ALERT",
      entityId: input.alertId,
      action: "ACKNOWLEDGED",
      actorId: input.actorId,
      reason: input.reason ?? null,
      afterValue: input.reason ? ({ reason: input.reason } as Prisma.InputJsonValue) : Prisma.JsonNull
    }
  });
}
