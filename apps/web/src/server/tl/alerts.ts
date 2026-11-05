import { prisma } from "@/lib/db";
import { alertsByLoad, countAlerts, deriveAlerts, type AlertLoad } from "@/lib/alerts";
import { alertThresholds } from "@/lib/thresholds";
import { detentionOfLoad, waivedDetentionLoads } from "./detention";
import { evaluateTlLoad } from "./evaluate";
import { notQuote } from "@/lib/quote-status";
import { getThresholds } from "./thresholds";
import { numOrNull } from "./convert";
import { deskStatusOf, inTerminal, loadInclude } from "./queries";
import { currentWorkspaceId } from "./workspace";
import { podStopsMissing } from "./documents";
import { answerCache, clockBucket } from "./answer-cache";

const OPEN = ["draft", "accepted", "in_progress", "scheduled", "dispatched"];
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
/**
 * The alerts for the loads in a terminal (and the loads not placed anywhere yet): the same alerts, narrowed. Which of the alerted loads are in the terminal is asked of the database
 * for just those loads, so a fleet's thousands of loads are not read to draw a screen.
 */
export async function getAlertsInTerminal(terminal: string | null, now = new Date(), workspaceId = currentWorkspaceId()) {
  const all = await getAlerts(now, workspaceId, "all");
  if (!terminal) return all;
  const ids = [...new Set(all.alerts.map((a) => a.loadId))];
  const mine = new Set((await prisma.load.findMany({ where: { id: { in: ids }, workspaceId, ...inTerminal(terminal) }, select: { id: true } })).map((l) => l.id));
  const alerts = all.alerts.filter((a) => mine.has(a.loadId));
  return { alerts, byLoad: alertsByLoad(alerts), counts: countAlerts(alerts), capped: all.capped, cap: all.cap };
}

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

  const [open, delivered, uninvoiced, extra, outOwed, t] = await Promise.all([
    full({ status: { in: OPEN } }),
    scope === "all" ? full({ status: "completed", completedAt: { gte: new Date(now.getTime() - DETENTION_WINDOW_DAYS * DAY) } }, DELIVERED_CAP) : Promise.resolve([]),
    // Delivered (or a TONU with a fee) and not invoiced, of ANY age but only the newest 500 (the window above is for detention): a delivery nobody invoiced does not stop being owed money after ninety days.
    scope === "all" ? full({ OR: [{ status: "completed" }, { status: "tonu", tonuRevenue: { gt: 0 } }], paymentStatus: null }, DELIVERED_CAP) : Promise.resolve([]),
    extraId ? full({ id: extraId }) : Promise.resolve([]),
    // Only what the overdue rule reads: no stops, no truck, no driver.
    scope === "open"
      ? Promise.resolve([])
      : prisma.load.findMany({ where: { ...base, paymentStatus: "invoiced" }, select: { id: true, loadNumber: true, status: true, paymentStatus: true, invoiceNumber: true, invoicedAt: true, payTermsDays: true } }),
    getThresholds(workspaceId)
  ]);

  // Whether each delivered load has its proof of delivery on file, for every delivered load read (one query for all of them).
  const completedIds = [...new Set([...delivered, ...uninvoiced, ...extra.filter((l) => l.status === "completed")].map((l) => l.id))];
  const [podMissing, waivedDetention] = await Promise.all([podStopsMissing(completedIds, workspaceId), waivedDetentionLoads(completedIds, workspaceId)]);
  const seen = new Set<string>();
  const input: AlertLoad[] = [];
  for (const l of [...open, ...delivered, ...uninvoiced, ...extra]) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    const profile = l.vehicle?.costProfile ?? null;
    const a = l.assignment;
    input.push({
      id: l.id,
      loadNumber: l.loadNumber,
      status: deskStatusOf(l.status),
      paymentStatus: l.paymentStatus,
      invoiceNumber: l.invoiceNumber,
      invoicedAt: l.invoicedAt,
      payTermsDays: l.payTermsDays,
      detentionUnbilled: l.status === "completed" && !waivedDetention.has(l.id) ? detentionOfLoad(l, t.detentionGraceMinutes).unbilled : 0,
      hasTruck: l.vehicleId != null,
      vehicle: l.vehicleId != null && l.vehicle ? { id: l.vehicleId, name: l.vehicle.name } : null,
      closedWithoutPod: l.closedWithoutPod,
      tonuFee: l.status === "tonu" ? numOrNull(l.tonuRevenue) : null,
      completedAt: l.completedAt,
      podStopsMissing: podMissing.get(l.id) ?? null,
      deliveryStops: l.stops.filter((s) => (s.stopRole ?? s.stopType) === "delivery").length,
      trailer: l.trailer ? { number: l.trailer.number, status: l.trailer.status, registrationExpiry: l.trailer.registrationExpiry, inspectionExpiry: l.trailer.inspectionExpiry } : null,
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
  // A read that hit its cap may have left older loads out: the Alerts screen says so instead of looking complete.
  const capped = scope === "all" && (delivered.length >= DELIVERED_CAP || uninvoiced.length >= DELIVERED_CAP);
  return { alerts, byLoad: alertsByLoad(alerts), counts: countAlerts(alerts), capped, cap: DELIVERED_CAP };
}
