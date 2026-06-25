/**
 * Daily-tracker alert engine (pure, client-side).
 *
 * Given a board load row (the already-fetched `ViewBoardLoadRow`), derive the set
 * of open "needs attention" items so the three tracker surfaces — the per-row
 * marker, the persistent rail, and desktop notifications — all read from ONE
 * derivation. No React, prisma, or fetch here so it stays unit-testable like
 * `server/kpi-alerts.ts`.
 *
 * Phase 1 derives only from signals that already exist in the board payload.
 * The `LoadAlertKind` union is intentionally open and `LoadAlertContext` carries
 * an optional `now` so the future appointment-time + per-leg workflow signals can
 * feed this same engine without changing any surface. See the Phase-2 seams note
 * in the plan.
 */
import type { ViewBoardLoadRow, ViewBoardResponse } from "@/lib/ui/board-mappers";

export type LoadAlertSeverity = "INFO" | "WARN" | "URGENT";

export type LoadAlertKind =
  | "MANUAL_FLAG"
  | "POD_REQUESTED"
  | "POD_NEEDS_ATTENTION"
  | "POD_SEND_OBLIGATION"
  | "TASK_MG"
  | "TASK_TMW"
  | "TASK_SCALE_BEFORE"
  | "TASK_SCALE_AFTER"
  | "COVERAGE_GAP"
  | "MISSING_RATECON"
  | "MISSING_PICKUP_NUMBER"
  | "MISSING_MILES"
  | "EMPTY_PCT_OVER"
  | "TONU_UNBILLED"
  | "STATUS_STALE"
  | "APPT_APPROACHING"
  | "APPT_MISSED"
  | "BOL_MATCH"
  | "ADVISE_PU_ETA"
  | "ADVISE_PU_ARRIVAL"
  | "ADVISE_DEL_ETA"
  | "ADVISE_DEL_ARRIVAL"
  | "LEG_VERIFY_ONSITE"
  | "HANDOFF_STALL"
  | "TRAILER_MISMATCH"
  | "WORK_IN_PENDING"
  | "DELIVERY_RESCHEDULE_WINDOW"
  | "RESCHEDULE_NEEDS_DRIVER";

export interface LoadAlert {
  kind: LoadAlertKind;
  severity: LoadAlertSeverity;
  /** Short, human label shown in the tooltip / rail. */
  label: string;
  /** True when this is a coordinator action ("do this now"), not just status. */
  isObligation: boolean;
  sourceLoadId: string;
  /** Stable identity for de-duping notifications: `${loadId}:${kind}`. */
  key: string;
}

export interface LoadAlertRollup {
  loadId: string;
  ref: string;
  alerts: LoadAlert[];
  count: number;
  topSeverity: LoadAlertSeverity | null;
  hasObligation: boolean;
  score: number;
}

export interface LoadAlertContext {
  /** Whole-percent empty-mile thresholds from the board config. */
  emptyPctAmber: number;
  emptyPctRed: number;
  /** Optional wall-clock (ms) for date-relative heuristics; omit to skip them. */
  now?: number;
}

const SEVERITY_RANK: Record<LoadAlertSeverity, number> = { INFO: 1, WARN: 2, URGENT: 3 };

/** How early a firm delivery appointment starts escalating (2 hours). */
const FIRM_APPT_LEAD_MS = 120 * 60 * 1000;

/** How long past a leg's ETA (with no arrival logged) before the verify nudge escalates to urgent (1 hour). */
const LEG_OVERDUE_MS = 60 * 60 * 1000;

/** Statuses where the load is still in-flight and its open tasks are relevant. */
const ACTIVE_STATUSES = new Set(["BOOKED", "DISPATCHED", "PICKED_UP", "DELIVERED", "POD_RECEIVED"]);
/** Pre-pickup statuses — where coverage / missing-data gaps still matter. */
const PRE_PICKUP_STATUSES = new Set(["BOOKED", "DISPATCHED"]);
/** In-transit statuses — where a leg's ETA→on-site verification matters. */
const IN_TRANSIT_STATUSES = new Set(["DISPATCHED", "PICKED_UP", "DELIVERED"]);

export function severityRank(severity: LoadAlertSeverity): number {
  return SEVERITY_RANK[severity];
}

function maxSeverity(a: LoadAlertSeverity | null, b: LoadAlertSeverity): LoadAlertSeverity {
  if (!a) return b;
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/** Does the load have anyone on it — pickup driver, delivery driver, or any leg driver? */
function hasAnyDriver(load: ViewBoardLoadRow): boolean {
  return Boolean(
    load.pickupDriverAssigned ||
      load.deliveryDriver ||
      (load.legs ?? []).some((leg) => leg.driverName && leg.driverName.trim().length > 0)
  );
}

function todayIso(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Derive the open alerts for a single load. Returns `[]` for fully-resolved
 * loads (COMPLETED) and for CANCELED loads — except a canceled load that still
 * carries a TONU keeps the "bill the broker" reminder.
 */
export function deriveLoadAlerts(load: ViewBoardLoadRow, ctx: LoadAlertContext): LoadAlert[] {
  const out: LoadAlert[] = [];
  const push = (
    kind: LoadAlertKind,
    severity: LoadAlertSeverity,
    label: string,
    isObligation: boolean,
    keySuffix = ""
  ) => {
    out.push({ kind, severity, label, isObligation, sourceLoadId: load.id, key: `${load.id}:${kind}${keySuffix}` });
  };

  // Terminal states carry no open work — except a canceled TONU still needs billing.
  // FAILED is a dead load like CANCELED/COMPLETED — it must not keep nagging.
  if (load.status === "CANCELED" || load.status === "COMPLETED" || load.status === "FAILED") {
    if (load.status === "CANCELED" && (load.tonuAmount ?? 0) > 0) {
      push("TONU_UNBILLED", "INFO", "TONU — bill the broker", true);
    }
    return out;
  }

  const active = ACTIVE_STATUSES.has(load.status);
  const prePickup = PRE_PICKUP_STATUSES.has(load.status);

  // 1. Manual flag (coordinator set the attention severity by hand).
  if (load.attentionSeverity === "URGENT" || load.attentionSeverity === "WARN") {
    push(
      "MANUAL_FLAG",
      load.attentionSeverity,
      load.lateCancelFailedNote?.trim() || "Flagged for attention",
      false
    );
  }

  // 2. POD workflow obligations.
  switch (load.podStatus) {
    case "NEEDS_ATTENTION":
      push("POD_NEEDS_ATTENTION", "URGENT", "POD needs attention", true);
      break;
    case "REQUESTED":
      push("POD_REQUESTED", "WARN", "POD requested — follow up", true);
      break;
    case "UPLOADED":
      push("POD_SEND_OBLIGATION", "WARN", "Send POD to broker", true);
      break;
    default:
      break; // SENT_TO_BROKER / NOT_REQUESTED / null → nothing
  }

  // 3. Open operational tasks (only while the load is still in-flight).
  if (active) {
    if (load.mgStatusTask === "NOT_DONE") push("TASK_MG", "INFO", "MG task not done", true);
    if (load.tmwStatusTask === "NOT_DONE") push("TASK_TMW", "INFO", "TMW task not done", true);
    if (load.scaleBeforeTask === "NOT_DONE") push("TASK_SCALE_BEFORE", "INFO", "Scale-before not done", true);
    if (load.scaleAfterTask === "NOT_DONE") push("TASK_SCALE_AFTER", "INFO", "Scale-after not done", true);
  }

  // 4. Coverage gap (flagship) — a pre-pickup load with no one assigned to move it.
  if (prePickup) {
    const legs = load.legs ?? [];
    if (!hasAnyDriver(load)) {
      push("COVERAGE_GAP", "URGENT", "No driver assigned", true);
    } else if (legs.length > 0 && legs.some((leg) => !leg.driverName?.trim())) {
      push("COVERAGE_GAP", "WARN", "A leg still needs a driver", true);
    }
  }

  // 5. Missing critical data.
  if (!load.rateConfirmationId) push("MISSING_RATECON", "WARN", "No rate confirmation", false);
  if (prePickup && !load.pickupNumber && (load.pickupNumbers?.length ?? 0) === 0) {
    push("MISSING_PICKUP_NUMBER", "WARN", "Missing pickup number", false);
  }
  if (active && (load.loadedMi === null || load.loadedMi === 0)) {
    push("MISSING_MILES", "INFO", "Missing loaded miles", false);
  }

  // 6. Empty-mile percentage over the region thresholds (emptyPct is a ratio).
  if (active && load.emptyPct !== null) {
    const pct = load.emptyPct * 100;
    if (pct >= ctx.emptyPctRed) {
      push("EMPTY_PCT_OVER", "URGENT", `Empty miles ${Math.round(pct)}% (over red)`, false);
    } else if (pct >= ctx.emptyPctAmber) {
      push("EMPTY_PCT_OVER", "WARN", `Empty miles ${Math.round(pct)}% (over amber)`, false);
    }
  }

  // 7. Conservative status-stale heuristics.
  if (load.status === "DELIVERED" && (load.podStatus === null || load.podStatus === "NOT_REQUESTED")) {
    push("STATUS_STALE", "INFO", "Delivered — request POD", true);
  }
  if (ctx.now !== undefined && load.status === "BOOKED" && load.deliveryDate) {
    if (load.deliveryDate.slice(0, 10) < todayIso(ctx.now)) {
      push("STATUS_STALE", "WARN", "Past delivery date, still booked", false);
    }
  }

  // 8. Firm delivery appointment escalation (Phase 2 — structured appointments).
  // Firm receiver appts (e.g. Allentown 00:01–09:30) escalate hard as they near
  // and harder once missed, while the load is still in-flight and undelivered.
  if (
    active &&
    ctx.now !== undefined &&
    load.deliveryApptType === "FIRM_APPT" &&
    load.deliveryWindowEndIso &&
    load.status !== "DELIVERED" &&
    load.status !== "POD_RECEIVED"
  ) {
    const apptEnd = Date.parse(load.deliveryWindowEndIso);
    if (Number.isFinite(apptEnd)) {
      if (ctx.now > apptEnd) {
        // Once the coordinator logs a resolution (work-in / reschedule), the
        // missed-nag gives way to the exception workflow obligations below.
        if (load.deliveryExceptionState === "NONE") {
          push("APPT_MISSED", "URGENT", "Firm delivery appt passed — not delivered", true);
        }
      } else if (apptEnd - ctx.now <= FIRM_APPT_LEAD_MS) {
        push("APPT_APPROACHING", "URGENT", "Firm delivery appt approaching", true);
      }
    }
  }

  // 9. Workflow obligations along the load's life (Phase 3). Gated by status so
  // each surfaces only at its point in the ladder and nags until checked off.
  if (load.status === "PICKED_UP") {
    // All-stop gate: once loaded at the shipper (the driver now has the BOL),
    // confirm it matches the rate con before heading to delivery — don't take
    // the wrong freight.
    if (load.bolMatchTask === "NOT_DONE") {
      push("BOL_MATCH", "URGENT", "Confirm BOL matches rate con", true);
    }
  }
  if (load.status === "DISPATCHED" && load.pickupEtaAdvised === "NOT_DONE") {
    push("ADVISE_PU_ETA", "WARN", "Advise broker of pickup ETA", true);
  }
  if (load.status === "PICKED_UP") {
    if (load.pickupArrivalAdvised === "NOT_DONE") {
      push("ADVISE_PU_ARRIVAL", "WARN", "Advise broker of pickup arrival", true);
    }
    if (load.deliveryEtaAdvised === "NOT_DONE") {
      push("ADVISE_DEL_ETA", "WARN", "Advise broker of delivery ETA", true);
    }
  }
  if (load.status === "DELIVERED" && load.deliveryArrivalAdvised === "NOT_DONE") {
    push("ADVISE_DEL_ARRIVAL", "WARN", "Advise broker of delivery arrival", true);
  }

  // 9b. Missed-appointment resolution workflow (Phase 3b). After a miss the
  // coordinator logs a work-in (same-day squeeze) or a reschedule (new appt,
  // usually next day); each surfaces its own follow-up nudge until resolved.
  if (active && load.status !== "DELIVERED" && load.status !== "POD_RECEIVED") {
    if (load.deliveryExceptionState === "WORK_IN_REQUESTED") {
      push("WORK_IN_PENDING", "WARN", "Work-in requested — confirm receiver slotted it", true);
    } else if (load.deliveryExceptionState === "RESCHEDULED") {
      // The core next-day-driver nudge — nags until the coordinator confirms.
      if (load.rescheduleDriverConfirmed === "NOT_DONE") {
        push("RESCHEDULE_NEEDS_DRIVER", "URGENT", "Rescheduled — assign next-day driver", true);
      }
      // Safety net: rescheduled but no valid forward window (or it re-passed).
      if (
        ctx.now !== undefined &&
        (!load.deliveryWindowEndIso || ctx.now > Date.parse(load.deliveryWindowEndIso))
      ) {
        push("DELIVERY_RESCHEDULE_WINDOW", "WARN", "Rescheduled — re-enter the new delivery window", true);
      }
    }
  }

  // 10. Per-leg verify-on-site nudge (Phase 3b). Once a leg's ETA passes with no
  // arrival logged, nag to verify the driver is on-site — escalating to urgent
  // once it's overdue (the driver may have fallen off). One alert per stale leg.
  if (ctx.now !== undefined && IN_TRANSIT_STATUSES.has(load.status)) {
    for (const leg of load.legs ?? []) {
      if (!leg.etaAtIso || leg.arrivalAtIso) continue;
      const eta = Date.parse(leg.etaAtIso);
      if (!Number.isFinite(eta) || ctx.now < eta) continue;
      const overdue = ctx.now - eta > LEG_OVERDUE_MS;
      push(
        "LEG_VERIFY_ONSITE",
        overdue ? "URGENT" : "WARN",
        overdue
          ? `Leg ${leg.legIndex} (${leg.legType}) overdue — confirm driver on-site`
          : `Leg ${leg.legIndex} (${leg.legType}) at ETA — verify driver on-site`,
        true,
        `:${leg.id}`
      );
    }
  }

  // 11. Handoff stall (focal point: every load delivered). A relayed load dies
  // quietly when the trailer lands at a node but no one is assigned to carry the
  // next leg onward. Once an upstream leg has logged arrival with the next leg
  // still driverless, raise it urgent so the baton is never dropped. One alert
  // per stalled handoff.
  if (active) {
    const legs = [...(load.legs ?? [])].sort((a, b) => a.legIndex - b.legIndex);
    for (let i = 0; i < legs.length - 1; i += 1) {
      const here = legs[i];
      const next = legs[i + 1];
      if (here.arrivalAtIso && !next.driverName?.trim()) {
        push(
          "HANDOFF_STALL",
          "URGENT",
          `Handoff ${here.legIndex}→${next.legIndex} stalled — assign a driver to the next leg`,
          true,
          `:${next.id}`
        );
      }
    }
  }

  // 12. Trailer mismatch across a handoff (focal point: trailer accuracy). Both
  // adjacent legs name a trailer, the numbers differ, and the hook hasn't been
  // confirmed — the wrong trailer may have been pulled. Urgent: wrong trailer =
  // wrong freight. One alert per mismatched handoff.
  if (active) {
    const legs = [...(load.legs ?? [])].sort((a, b) => a.legIndex - b.legIndex);
    for (let i = 0; i < legs.length - 1; i += 1) {
      const a = legs[i].trailer?.trim().toUpperCase();
      const b = legs[i + 1].trailer?.trim().toUpperCase();
      if (a && b && a !== b && legs[i + 1].trailerHookConfirmed !== "DONE") {
        push(
          "TRAILER_MISMATCH",
          "URGENT",
          `Trailer changed ${legs[i].legIndex}→${legs[i + 1].legIndex} (${legs[i].trailer} → ${legs[i + 1].trailer}) — confirm correct trailer`,
          true,
          `:${legs[i + 1].id}`
        );
      }
    }
  }

  return out;
}

/** Roll a load's alerts up to a single marker/rail entry. */
export function rollupLoadAlerts(load: ViewBoardLoadRow, ctx: LoadAlertContext): LoadAlertRollup {
  const alerts = deriveLoadAlerts(load, ctx);
  let topSeverity: LoadAlertSeverity | null = null;
  let hasObligation = false;
  for (const alert of alerts) {
    topSeverity = maxSeverity(topSeverity, alert.severity);
    if (alert.isObligation) hasObligation = true;
  }
  const rollup: LoadAlertRollup = {
    loadId: load.id,
    ref: load.ref,
    alerts,
    count: alerts.length,
    topSeverity,
    hasObligation,
    score: 0
  };
  rollup.score = scoreRollup(rollup);
  return rollup;
}

/**
 * Sort key for the rail / notifications: obligations first, then severity, then
 * how many open items, so the most demanding loads float to the top.
 */
export function scoreRollup(rollup: LoadAlertRollup): number {
  const obligation = rollup.hasObligation ? 1 : 0;
  const sev = rollup.topSeverity ? SEVERITY_RANK[rollup.topSeverity] : 0;
  return obligation * 1_000_000 + sev * 1_000 + rollup.count;
}

function buildContext(board: ViewBoardResponse): LoadAlertContext {
  return {
    emptyPctAmber: board.config.emptyPctAmber,
    emptyPctRed: board.config.emptyPctRed
  };
}

/**
 * Roll up every load on the board, keep only those with open items, and sort by
 * score (desc) with a stable `ref` tie-break. Drives both the rail and the
 * per-row marker (caller can index the result by `loadId`).
 */
export function collectBoardAlertRollups(
  board: ViewBoardResponse,
  ctx: LoadAlertContext = buildContext(board)
): LoadAlertRollup[] {
  const rollups: LoadAlertRollup[] = [];
  for (const section of board.sections) {
    for (const load of section.loads) {
      const rollup = rollupLoadAlerts(load, ctx);
      if (rollup.count > 0) rollups.push(rollup);
    }
  }
  rollups.sort((a, b) => (b.score - a.score) || a.ref.localeCompare(b.ref));
  return rollups;
}

/**
 * Keys present now that weren't in `prevSet`. The notifier feeds it the URGENT
 * alert keys each poll so it only fires for newly-appearing urgent items.
 */
export function diffNewUrgentKeys(prevSet: Set<string>, currentKeys: string[]): string[] {
  return currentKeys.filter((key) => !prevSet.has(key));
}
