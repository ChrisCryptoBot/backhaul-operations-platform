import { prisma } from "@/lib/db";
import { alertsByLoad, countAlerts, deriveAlerts, type AlertLoad } from "@/lib/alerts";
import { evaluateTlLoad } from "./evaluate";
import { loadInclude } from "./queries";
import { DEMO_WORKSPACE_ID } from "./workspace";

/** Reads the loads and applies the alert rules (src/lib/alerts.ts). Nothing is stored: the alerts are as fresh as the rows. */
export async function getAlerts(now = new Date(), workspaceId = DEMO_WORKSPACE_ID) {
  const loads = await prisma.load.findMany({ where: { workspaceId, deletedAt: null }, include: loadInclude });
  const input: AlertLoad[] = loads.map((l) => {
    const profile = l.vehicle?.costProfile ?? null;
    const a = l.assignment;
    return {
      id: l.id,
      loadNumber: l.loadNumber,
      status: l.status,
      paymentStatus: l.paymentStatus,
      invoiceNumber: l.invoiceNumber,
      invoicedAt: l.invoicedAt,
      payTermsDays: l.payTermsDays,
      verdict: profile ? (evaluateTlLoad(l, profile, l.vehicle)?.finalDecision ?? null) : null,
      stops: l.stops.map((s) => ({ timeWindowEarliest: s.timeWindowEarliest, timeWindowLatest: s.timeWindowLatest, referenceNumbers: s.referenceNumbers })),
      assignment: a ? { status: a.status, dispatchedAt: a.dispatchedAt, driver: { id: a.driver.id, name: a.driver.name, cdlExpiry: a.driver.cdlExpiry, medicalCardExpiry: a.driver.medicalCardExpiry } } : null
    };
  });
  const alerts = deriveAlerts(input, now);
  return { alerts, byLoad: alertsByLoad(alerts), counts: countAlerts(alerts) };
}
