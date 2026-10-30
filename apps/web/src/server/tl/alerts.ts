import { prisma } from "@/lib/db";
import { alertsByLoad, countAlerts, deriveAlerts, type AlertLoad } from "@/lib/alerts";
import { alertThresholds } from "@/lib/thresholds";
import { detentionOfLoad } from "./detention";
import { evaluateTlLoad } from "./evaluate";
import { notQuote } from "@/lib/quote-status";
import { getThresholds } from "./thresholds";
import { loadInclude } from "./queries";
import { currentWorkspaceId } from "./workspace";
import { answerCache, clockBucket } from "./answer-cache";

const OPEN = ["draft", "accepted", "in_progress"];
const DAY = 86_400_000;
import { DETENTION_WINDOW_DAYS } from "./detention";
/** The most recent delivered loads the Alerts screen reads for "ready to invoice" and detention. */
const DELIVERED_CAP = 500;

/**
 * Which loads are read.
 *  - "shell": what the header and sidebar counts need: open loads, plus every invoice still out (for overdue). Nothing else can raise a counted alert.
 *  - "open": open loads only, for screens that show a load's alert dot (Loads, Dispatch).
 *  - "all": the Alerts screen: open loads, the delivered ones of the last 90 days (up to 500 newest), and every invoice still out.
 * `extraId` adds one more load (a delivered load whose page is open) so its own alerts still show.
 */
export type AlertScope = "shell" | "open" | "all";

/** Reads the loads that can raise an alert and applies the rules (src/lib/alerts.ts). Nothing is stored: the alerts are as fresh as the rows. */
const answers = answerCache<Awaited<ReturnType<typeof buildAlerts>>>(60);
/** Tests clear it between cases. */
export const clearAlertCache = () => answers.clear();

/**
 * The alerts as of now. They are worked out from every load that can raise one, which every screen's header needs, so the answer is kept until the data moves or
 * the minute turns (the rules read the clock in hours and days; answer-cache.ts).
 */
export async function getAlerts(now = new Date(), workspaceId = currentWorkspaceId(), scope: AlertScope = "all", extraId?: string) {
  const t = await getThresholds(workspaceId);
  return answers.remember([workspaceId, scope, extraId ?? null, clockBucket(now.getTime(), 60_000), t], workspaceId, () => buildAlerts(now, workspaceId, scope, extraId));
}

async function buildAlerts(now: Date, workspaceId: string, scope: AlertScope, extraId?: string) {
  const base = { workspaceId, deletedAt: null, ...notQuote };
  const full = (where: object, take?: number) => prisma.load.findMany({ where: { ...base, ...where }, include: loadInclude, ...(take ? { orderBy: { completedAt: "desc" as const }, take } : {}) });

  const [open, delivered, extra, outOwed, t] = await Promise.all([
    full({ status: { in: OPEN } }),
    scope === "all" ? full({ status: "completed", completedAt: { gte: new Date(now.getTime() - DETENTION_WINDOW_DAYS * DAY) } }, DELIVERED_CAP) : Promise.resolve([]),
    extraId ? full({ id: extraId }) : Promise.resolve([]),
    // Only what the overdue rule reads: no stops, no truck, no driver.
    scope === "open"
      ? Promise.resolve([])
      : prisma.load.findMany({ where: { ...base, paymentStatus: "invoiced" }, select: { id: true, loadNumber: true, status: true, paymentStatus: true, invoiceNumber: true, invoicedAt: true, payTermsDays: true } }),
    getThresholds(workspaceId)
  ]);

  const seen = new Set<string>();
  const input: AlertLoad[] = [];
  for (const l of [...open, ...delivered, ...extra]) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    const profile = l.vehicle?.costProfile ?? null;
    const a = l.assignment;
    input.push({
      id: l.id,
      loadNumber: l.loadNumber,
      status: l.status,
      paymentStatus: l.paymentStatus,
      invoiceNumber: l.invoiceNumber,
      invoicedAt: l.invoicedAt,
      payTermsDays: l.payTermsDays,
      detentionUnbilled: l.status === "completed" ? detentionOfLoad(l, t.detentionGraceMinutes).unbilled : 0,
      hasTruck: l.vehicleId != null,
      // The verdict only matters for a draft nobody has been sent (BELOW_COST_UNASSIGNED): no need to price anything else.
      verdict: l.status === "draft" && profile ? (evaluateTlLoad(l, profile, l.vehicle)?.finalDecision ?? null) : null,
      stops: l.stops.map((s) => ({ timeWindowEarliest: s.timeWindowEarliest, timeWindowLatest: s.timeWindowLatest, referenceNumbers: s.referenceNumbers })),
      assignment: a ? { status: a.status, dispatchedAt: a.dispatchedAt, driver: { id: a.driver.id, name: a.driver.name, cdlExpiry: a.driver.cdlExpiry, medicalCardExpiry: a.driver.medicalCardExpiry } } : null
    });
  }
  for (const l of outOwed) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    input.push({ id: l.id, loadNumber: l.loadNumber, status: l.status, paymentStatus: l.paymentStatus, invoiceNumber: l.invoiceNumber, invoicedAt: l.invoicedAt, payTermsDays: l.payTermsDays, detentionUnbilled: 0, hasTruck: true, verdict: null, stops: [], assignment: null });
  }
  const alerts = deriveAlerts(input, now, alertThresholds(t));
  return { alerts, byLoad: alertsByLoad(alerts), counts: countAlerts(alerts) };
}
