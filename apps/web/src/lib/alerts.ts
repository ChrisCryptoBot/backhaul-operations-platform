import { daysPastDue } from "./overdue";
import { clearanceSoon, driverBlocker } from "./clearance";
import { trailerBlocker, trailerClearanceSoon } from "./trailer-clearance";
import { loadWindow, windowsOverlap, type Window } from "./schedule";

/**
 * Per-load alerts, derived from the rows on every request (nothing is stored). Three levels:
 *   block  fix this before the load goes out, or it will go wrong
 *   warn   look at this soon
 *   info   for your information
 * `RULES` is the catalogue the Rules page lists; `deriveAlerts` applies it. Pure.
 */
export type AlertLevel = "block" | "warn" | "info";
export type AlertCode =
  | "DRIVER_CLEARANCE"
  | "DOUBLE_BOOKED"
  | "PICKUP_NO_DRIVER"
  | "NO_TRUCK"
  | "LATE_ON_ROAD"
  | "LATE_TO_PICKUP"
  | "TRUCK_DOUBLE_BOOKED"
  | "SENT_NO_ANSWER"
  | "CLEARANCE_SOON"
  | "TRAILER_COMPLIANCE"
  | "BELOW_COST_UNASSIGNED"
  | "INVOICE_OVERDUE"
  | "MISSING_REFERENCE"
  | "READY_TO_INVOICE"
  | "MISSING_POD"
  | "DETENTION_UNBILLED";

/** The thresholds the rules use. Fixed for now; the settings screen will own them. */
export type AlertThresholds = { pickupHours: number; sentNoAnswerHours: number; clearanceDays: number };
export const ALERT_DEFAULTS: AlertThresholds = { pickupHours: 24, sentNoAnswerHours: 4, clearanceDays: 30 };

export type RuleDef = { code: AlertCode; level: AlertLevel; title: string; appliesTo: string; trigger: (t: AlertThresholds) => string };

export const RULES: RuleDef[] = [
  {
    code: "DRIVER_CLEARANCE",
    level: "block",
    title: "Driver's CDL or medical card has lapsed",
    appliesTo: "Open loads with a driver",
    trigger: () => "The assigned driver's CDL or medical card expiry date is in the past."
  },
  {
    code: "TRAILER_COMPLIANCE",
    level: "block",
    title: "Trailer cannot go out, or its papers are about to lapse",
    appliesTo: "Open loads with a trailer",
    trigger: (t) => `The trailer on the load is in the shop or out of service, or its registration or inspection date is in the past (a block), or falls within ${t.clearanceDays} days (a warning).`
  },
  {
    code: "DOUBLE_BOOKED",
    level: "block",
    title: "Driver is booked on overlapping loads",
    appliesTo: "Open loads with a driver",
    trigger: () => "Two open loads for one driver run from the first stop's earliest time to the last stop's latest time, and those windows overlap."
  },
  {
    code: "PICKUP_NO_DRIVER",
    level: "block",
    title: "Pickup is close and no driver has been sent",
    appliesTo: "Loads still waiting for a driver",
    trigger: (t) => `The first pickup is within ${t.pickupHours} hours (or already past) and no driver has been sent the load.`
  },
  {
    code: "TRUCK_DOUBLE_BOOKED",
    level: "block",
    title: "Truck is on overlapping loads",
    appliesTo: "Open loads with a truck",
    trigger: () => "Two open loads are on one truck and their windows (first stop's earliest time to the last stop's latest) overlap, whoever drives."
  },
  {
    code: "NO_TRUCK",
    level: "warn",
    title: "Load has no truck",
    appliesTo: "Open loads",
    trigger: () => "A load that is not yet delivered has no truck set, so it has no cost floor and no verdict."
  },
  {
    code: "LATE_ON_ROAD",
    level: "warn",
    title: "On the road and past its delivery window",
    appliesTo: "Loads on the road",
    trigger: () => "The load is on the road and its final stop's delivery window has closed without it being delivered."
  },
  {
    code: "LATE_TO_PICKUP",
    level: "warn",
    title: "Pickup time has passed and the driver has not picked up",
    appliesTo: "Loads sent to or accepted by a driver, not yet on the road",
    trigger: () => "The driver has the load (sent or accepted), the first stop's window has closed, and the pickup has not been entered, so the load is not on the road."
  },
  {
    code: "SENT_NO_ANSWER",
    level: "warn",
    title: "Sent to a driver and no answer yet",
    appliesTo: "Loads sent to a driver",
    trigger: (t) => `The load was sent more than ${t.sentNoAnswerHours} hours ago and the driver has not accepted or declined.`
  },
  {
    code: "CLEARANCE_SOON",
    level: "warn",
    title: "Driver's CDL or medical card lapses soon",
    appliesTo: "Open loads with a driver",
    trigger: (t) => `The assigned driver's CDL or medical card expires within ${t.clearanceDays} days.`
  },
  {
    code: "BELOW_COST_UNASSIGNED",
    level: "warn",
    title: "Load pays below the truck's cost and has no driver sent",
    appliesTo: "Loads waiting for a driver",
    trigger: () => "The load pays less than the truck's own cost, so the verdict card says Reject, and it has not been sent to a driver."
  },
  {
    code: "INVOICE_OVERDUE",
    level: "warn",
    title: "Invoice is past its payment terms",
    appliesTo: "Invoiced loads",
    trigger: () => "The invoice date plus the load's payment terms is in the past and the invoice is unpaid."
  },
  {
    code: "MISSING_REFERENCE",
    level: "info",
    title: "A stop has no reference number",
    appliesTo: "Open loads with a driver",
    trigger: () => "A stop has no pickup or delivery number, which the dock will ask the driver for."
  },
  {
    code: "READY_TO_INVOICE",
    level: "info",
    title: "Delivered and not invoiced",
    appliesTo: "Delivered loads",
    trigger: () => "The load is delivered and no invoice has been created."
  },
  {
    code: "MISSING_POD",
    level: "info",
    title: "Delivered with no proof of delivery",
    appliesTo: "Delivered loads",
    trigger: () => "The load was closed without proof of delivery. Customers often hold payment, and a factor will not fund it, until they have it."
  },
  {
    code: "DETENTION_UNBILLED",
    level: "info",
    title: "Detention that was never billed",
    appliesTo: "Delivered loads",
    trigger: () => "A stop waited past the truck's free time and the invoice (or no invoice yet) does not carry the detention."
  }
];

export const LEVEL_LABEL: Record<AlertLevel, string> = { block: "Block", warn: "Warn", info: "Info" };

export type AlertLoad = {
  id: string;
  loadNumber: string | null;
  status: string;
  paymentStatus: string | null;
  invoiceNumber: string | null;
  invoicedAt: Date | null;
  payTermsDays: number | null;
  /** Detention that is owed on a delivered load and not on any invoice, in dollars (0 or absent when none). */
  detentionUnbilled?: number;
  verdict: "accept" | "caution" | "reject" | "needs_fuel" | null;
  /** Whether a truck is set on the load. Absent is read as having one, so a caller that does not know raises nothing. */
  hasTruck?: boolean;
  /** The truck on the load, when one is set (for two loads on one truck at once). */
  vehicle?: { id: string; name: string | null } | null;
  /** When the load was delivered, for how long a proof of delivery has been missing. */
  completedAt?: Date | null;
  /** Delivery stops with no proof of delivery file on file (a proof with no stop named covers the load); absent when not known. */
  podStopsMissing?: number | null;
  deliveryStops?: number;
  /** True when a delivered load was closed with no proof of delivery. */
  closedWithoutPod?: boolean | null;
  /** The trailer unit on the load, when one is set. */
  trailer?: { number: string; status: string; registrationExpiry: Date | null; inspectionExpiry: Date | null } | null;
  stops: Array<{ timeWindowEarliest: Date | null; timeWindowLatest: Date | null; referenceNumbers: unknown }>;
  assignment: null | {
    status: string;
    dispatchedAt: Date | null;
    driver: { id: string; name: string; cdlExpiry: Date | null; medicalCardExpiry: Date | null };
  };
};

export type Alert = { key: string; code: AlertCode; level: AlertLevel; loadId: string; loadNumber: string | null; message: string };

const HOUR = 3_600_000;
const DAY = 86_400_000;
const OPEN = ["draft", "accepted", "in_progress"];
/** A delivered load with no proof of delivery file is flagged after this many days. */
export const POD_ALERT_DAYS = 21;

const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
const hours = (ms: number) => (ms >= DAY ? `${Math.floor(ms / DAY)} d` : `${Math.max(1, Math.floor(ms / HOUR))} h`);
const hasRefs = (v: unknown) => Array.isArray(v) && v.some((x) => typeof x === "string" && x.trim() !== "");

const ORDER: Record<AlertLevel, number> = { block: 0, warn: 1, info: 2 };

export function deriveAlerts(loads: AlertLoad[], now: Date, t: AlertThresholds = ALERT_DEFAULTS): Alert[] {
  const out: Alert[] = [];
  const add = (l: AlertLoad, code: AlertCode, level: AlertLevel, message: string, key: string = code) => out.push({ key: `${l.id}:${key}`, code, level, loadId: l.id, loadNumber: l.loadNumber, message });

  for (const l of loads) {
    const open = OPEN.includes(l.status);
    const a = l.assignment;
    const holding = a != null && a.status !== "declined";
    const unsent = !a || a.status === "draft" || a.status === "declined";

    if (open && l.hasTruck === false) add(l, "NO_TRUCK", "warn", "No truck is set, so this load has no cost floor and no verdict. Pick one under Edit details.");

    // The driver has the load and its pickup window is over, but the pickup was never entered: the load is not on the road. (A late arrival is the driver's; a pickup nobody has
    // recorded is the desk's, and the load is wrong on the board until it is.)
    if (open && l.status !== "in_progress" && a != null && (a.status === "dispatched" || a.status === "accepted")) {
      const first = l.stops[0];
      const closes = first?.timeWindowLatest ?? first?.timeWindowEarliest ?? null;
      if (closes && closes.getTime() < now.getTime()) add(l, "LATE_TO_PICKUP", "warn", `The pickup window closed ${hours(now.getTime() - closes.getTime())} ago and the pickup has not been entered. Is ${a.driver.name} on the road?`);
    }

    if (l.status === "in_progress") {
      // The delivery is the final stop. With no closing time on it there is no deadline to be late for.
      const close = l.stops[l.stops.length - 1]?.timeWindowLatest ?? null;
      if (close && close.getTime() < now.getTime()) add(l, "LATE_ON_ROAD", "warn", `The delivery window closed ${hours(now.getTime() - close.getTime())} ago and the load is not delivered.`);
    }

    if (open && l.trailer) {
      const why = trailerBlocker(l.trailer, now);
      if (why) add(l, "TRAILER_COMPLIANCE", "block", `Trailer ${l.trailer.number}: ${why.toLowerCase()}.`);
      else {
        const soon = trailerClearanceSoon(l.trailer, now, t.clearanceDays);
        if (soon) add(l, "TRAILER_COMPLIANCE", "warn", `Trailer ${l.trailer.number}'s ${soon.what} lapses in ${soon.inDays} ${soon.inDays === 1 ? "day" : "days"} (${day(soon.on)}).`);
      }
    }

    if (open && holding) {
      const blocker = driverBlocker(a!.driver, now);
      if (blocker) add(l, "DRIVER_CLEARANCE", "block", `${a!.driver.name}: ${blocker}.`);
      else {
        const soon = clearanceSoon(a!.driver, now, t.clearanceDays);
        if (soon) add(l, "CLEARANCE_SOON", "warn", `${a!.driver.name}'s ${soon.what} lapses in ${soon.inDays} ${soon.inDays === 1 ? "day" : "days"} (${day(soon.on)}).`);
      }
      if (l.stops.some((s) => !hasRefs(s.referenceNumbers))) add(l, "MISSING_REFERENCE", "info", "A stop has no reference number for the driver to give the dock.");
    }

    if (l.status === "draft" && unsent) {
      const w = loadWindow(l.stops);
      if (w) {
        const until = w.start.getTime() - now.getTime();
        if (until <= t.pickupHours * HOUR) {
          add(l, "PICKUP_NO_DRIVER", "block", until < 0 ? "The pickup time has passed and no driver has been sent." : `Pickup is in ${hours(until)} and no driver has been sent.`);
        }
      }
      if (l.verdict === "reject") add(l, "BELOW_COST_UNASSIGNED", "warn", "Pays below the truck's cost and has no driver sent.");
    }

    if (a?.status === "dispatched" && a.dispatchedAt) {
      const waited = now.getTime() - a.dispatchedAt.getTime();
      if (waited >= t.sentNoAnswerHours * HOUR) add(l, "SENT_NO_ANSWER", "warn", `Sent to ${a.driver.name} ${hours(waited)} ago and no answer yet.`);
    }

    if (l.paymentStatus === "invoiced" && l.invoicedAt) {
      const late = daysPastDue(l.invoicedAt, l.payTermsDays, now) ?? 0;
      if (late > 0) add(l, "INVOICE_OVERDUE", "warn", `${l.invoiceNumber ?? "Invoice"} is ${late} ${late === 1 ? "day" : "days"} past its terms.`);
    }

    if (l.status === "completed" && !l.paymentStatus) add(l, "READY_TO_INVOICE", "info", "Delivered and not invoiced yet.");
    if (l.status === "completed" && l.closedWithoutPod === true) add(l, "MISSING_POD", "info", "Closed without proof of delivery.");
    // Delivered three weeks ago and still no proof of delivery file: the customer can refuse to pay, and the factor will not buy the invoice without it.
    else if (l.status === "completed" && (l.podStopsMissing ?? 0) > 0 && l.completedAt && now.getTime() - l.completedAt.getTime() >= POD_ALERT_DAYS * DAY) {
      const of = (l.deliveryStops ?? 0) > 1 ? ` for ${l.podStopsMissing} of ${l.deliveryStops} delivery stops` : "";
      add(l, "MISSING_POD", "warn", `Delivered ${Math.floor((now.getTime() - l.completedAt.getTime()) / DAY)} days ago and no proof of delivery is on file${of}.`, "MISSING_POD_FILE");
    }
    if (l.status === "completed" && (l.detentionUnbilled ?? 0) > 0) add(l, "DETENTION_UNBILLED", "info", `$${l.detentionUnbilled!.toFixed(2)} of detention can still be billed.`);
  }

  // Double booking: one driver on two open loads whose windows overlap. Reported on both loads, naming the other.
  const byDriver = new Map<string, Array<{ load: AlertLoad; win: Window }>>();
  for (const l of loads) {
    if (!OPEN.includes(l.status) || !l.assignment || l.assignment.status === "declined") continue;
    const win = loadWindow(l.stops);
    if (!win) continue;
    const list = byDriver.get(l.assignment.driver.id) ?? [];
    list.push({ load: l, win });
    byDriver.set(l.assignment.driver.id, list);
  }
  for (const list of byDriver.values()) {
    for (const x of list) {
      const clash = list.filter((y) => y.load.id !== x.load.id && windowsOverlap(x.win, y.win));
      if (clash.length === 0) continue;
      const names = clash.map((y) => y.load.loadNumber ?? "another load").join(", ");
      add(x.load, "DOUBLE_BOOKED", "block", `${x.load.assignment!.driver.name} is also booked on ${names} at the same time.`);
    }
  }

  // One truck on two open loads whose windows overlap, whoever drives (the driver check above does not see a truck two dispatchers put on two loads).
  const byTruck = new Map<string, Array<{ load: AlertLoad; win: Window }>>();
  for (const l of loads) {
    if (!OPEN.includes(l.status) || !l.vehicle) continue;
    const win = loadWindow(l.stops);
    if (!win) continue;
    const list = byTruck.get(l.vehicle.id) ?? [];
    list.push({ load: l, win });
    byTruck.set(l.vehicle.id, list);
  }
  for (const list of byTruck.values()) {
    for (const x of list) {
      const clash = list.filter((y) => y.load.id !== x.load.id && windowsOverlap(x.win, y.win));
      if (clash.length === 0) continue;
      add(x.load, "TRUCK_DOUBLE_BOOKED", "block", `${x.load.vehicle!.name ?? "The truck"} is also on ${clash.map((y) => y.load.loadNumber ?? "another load").join(", ")} at the same time.`);
    }
  }

  return out.sort((x, y) => ORDER[x.level] - ORDER[y.level] || (x.loadNumber ?? "").localeCompare(y.loadNumber ?? "") || x.code.localeCompare(y.code));
}

export function alertsByLoad(alerts: Alert[]): Map<string, Alert[]> {
  const m = new Map<string, Alert[]>();
  for (const a of alerts) m.set(a.loadId, [...(m.get(a.loadId) ?? []), a]);
  return m;
}

export function countAlerts(alerts: Alert[]): Record<AlertLevel, number> {
  return { block: alerts.filter((a) => a.level === "block").length, warn: alerts.filter((a) => a.level === "warn").length, info: alerts.filter((a) => a.level === "info").length };
}

/** The most serious level among a load's alerts. */
export function topLevel(alerts: Alert[] | undefined): AlertLevel | null {
  if (!alerts || alerts.length === 0) return null;
  return alerts.reduce<AlertLevel>((best, a) => (ORDER[a.level] < ORDER[best] ? a.level : best), "info");
}
