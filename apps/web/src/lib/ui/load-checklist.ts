/**
 * Per-load managed checklist (pure, client + server).
 *
 * The alert engine (`load-alerts.ts`) emits only the OPEN obligations relevant
 * right now. The checklist is the steady-state companion: the full set of
 * lifecycle non-negotiables for a load, each marked done / open / blocked,
 * grouped by the stage it must be completed by. One registry is the source of
 * truth, consumed by the drawer checklist panel AND the server-side status gate
 * (`setBoardLoadStatus`), so enforcement and display never drift.
 *
 * Relay-aware: beyond the load-level lifecycle non-negotiables, the checklist
 * also generates a per-leg + per-handoff "relay" dimension from the load's legs
 * (driver / ETA / arrival per leg, baton-confirmed per handoff). The count grows
 * and shrinks with the relay — a direct load yields no handoff items. These are
 * SOFT and display-only for accountability: the status gate
 * (`stageExitObligations`) is driven by the load-level items alone.
 *
 * Time-based / missed-appt nudges (APPT_*, LEG_VERIFY_ONSITE, HANDOFF_STALL,
 * WORK_IN/RESCHEDULE) are exception alerts, not steady-state checkboxes, so they
 * live only in the alert engine — not here.
 */
import type { LoadAlertSeverity } from "@/lib/ui/load-alerts";

type DoneFlag = "NOT_DONE" | "DONE";

/** Structural subset of ViewBoardLoadRow the checklist needs. A server projection satisfies it too. */
export interface ChecklistLoadInput {
  status: string;
  mgStatusTask: DoneFlag;
  tmwStatusTask: DoneFlag;
  scaleBeforeTask: DoneFlag;
  scaleAfterTask: DoneFlag;
  bolMatchTask: DoneFlag;
  pickupEtaAdvised: DoneFlag;
  pickupArrivalAdvised: DoneFlag;
  deliveryEtaAdvised: DoneFlag;
  deliveryArrivalAdvised: DoneFlag;
  podStatus: string | null;
  rateConfirmationId: string | null;
  pickupNumber: string | null;
  pickupNumbers: string[];
  pickupDriverAssigned: string | null;
  deliveryDriver: string | null;
  /**
   * Legs in chain order. `driverName` is the only field the server status-gate
   * projects; the rest are optional so a narrow projection still satisfies the
   * type. The drawer passes a full `ViewBoardLoadRow`, which carries them all and
   * lights up the per-leg / per-handoff relay items.
   */
  legs: Array<{
    driverName: string | null;
    id?: string;
    legIndex?: number;
    legType?: string;
    etaAtIso?: string | null;
    arrivalAtIso?: string | null;
    trailer?: string | null;
    trailerHookConfirmed?: string;
  }>;
}

/** Lifecycle stage a checklist item must be completed by (= checked when leaving that stage). */
export type ChecklistStage = "BOOKED" | "DISPATCHED" | "PICKED_UP" | "DELIVERED" | "POD_RECEIVED";

export const CHECKLIST_STAGES: ChecklistStage[] = ["BOOKED", "DISPATCHED", "PICKED_UP", "DELIVERED", "POD_RECEIVED"];

const STAGE_LABELS: Record<ChecklistStage, string> = {
  BOOKED: "Booked",
  DISPATCHED: "Dispatched",
  PICKED_UP: "Picked up",
  DELIVERED: "Delivered",
  POD_RECEIVED: "POD received"
};

interface ChecklistItemDef {
  key: string;
  label: string;
  stage: ChecklistStage;
  severity: LoadAlertSeverity;
  /** Blocks status advancement past its stage when open (no override). */
  hardGate?: boolean;
  applies: (load: ChecklistLoadInput) => boolean;
  isDone: (load: ChecklistLoadInput) => boolean;
}

/** Any driver assigned — load-level pickup/delivery or any leg. Mirrors the coverage-gap alert rule. */
export function hasAnyDriver(load: ChecklistLoadInput): boolean {
  return Boolean(
    load.pickupDriverAssigned ||
      load.deliveryDriver ||
      (load.legs ?? []).some((leg) => leg.driverName && leg.driverName.trim().length > 0)
  );
}

const POD_REQUESTED_STATES = new Set(["REQUESTED", "UPLOADED", "SENT_TO_BROKER"]);

/** The lifecycle non-negotiables, in stage order. Keys reuse the alert kinds where one exists. */
export const CHECKLIST_ITEMS: ChecklistItemDef[] = [
  // BOOKED — must be true to dispatch.
  {
    key: "COVERAGE_GAP",
    label: "Assign driver / coverage",
    stage: "BOOKED",
    severity: "URGENT",
    hardGate: true,
    applies: () => true,
    isDone: hasAnyDriver
  },
  {
    key: "MISSING_RATECON",
    label: "Rate confirmation on file",
    stage: "BOOKED",
    severity: "WARN",
    applies: () => true,
    isDone: (l) => Boolean(l.rateConfirmationId)
  },
  {
    key: "MISSING_PICKUP_NUMBER",
    label: "Pickup number captured",
    stage: "BOOKED",
    severity: "WARN",
    applies: () => true,
    isDone: (l) => Boolean(l.pickupNumber) || (l.pickupNumbers?.length ?? 0) > 0
  },
  // DISPATCHED — done by the time the load is picked up.
  {
    key: "TASK_MG",
    label: "MG task done",
    stage: "DISPATCHED",
    severity: "INFO",
    applies: () => true,
    isDone: (l) => l.mgStatusTask === "DONE"
  },
  {
    key: "TASK_TMW",
    label: "TMW task done",
    stage: "DISPATCHED",
    severity: "INFO",
    applies: () => true,
    isDone: (l) => l.tmwStatusTask === "DONE"
  },
  {
    key: "ADVISE_PU_ETA",
    label: "Advise broker of pickup ETA",
    stage: "DISPATCHED",
    severity: "WARN",
    applies: () => true,
    isDone: (l) => l.pickupEtaAdvised === "DONE"
  },
  // PICKED_UP — done by the time the load is delivered. BOL-match lives here:
  // the driver doesn't get the BOL paperwork until they're at the shipper + loaded.
  {
    key: "BOL_MATCH",
    label: "BOL matches rate con",
    stage: "PICKED_UP",
    severity: "URGENT",
    applies: () => true,
    isDone: (l) => l.bolMatchTask === "DONE"
  },
  {
    key: "ADVISE_PU_ARRIVAL",
    label: "Advise broker of pickup arrival",
    stage: "PICKED_UP",
    severity: "WARN",
    applies: () => true,
    isDone: (l) => l.pickupArrivalAdvised === "DONE"
  },
  {
    key: "ADVISE_DEL_ETA",
    label: "Advise broker of delivery ETA",
    stage: "PICKED_UP",
    severity: "WARN",
    applies: () => true,
    isDone: (l) => l.deliveryEtaAdvised === "DONE"
  },
  {
    key: "TASK_SCALE_BEFORE",
    label: "Scale-before done",
    stage: "PICKED_UP",
    severity: "INFO",
    applies: () => true,
    isDone: (l) => l.scaleBeforeTask === "DONE"
  },
  // DELIVERED — done by the time POD is received.
  {
    key: "ADVISE_DEL_ARRIVAL",
    label: "Advise broker of delivery arrival",
    stage: "DELIVERED",
    severity: "WARN",
    applies: () => true,
    isDone: (l) => l.deliveryArrivalAdvised === "DONE"
  },
  {
    key: "TASK_SCALE_AFTER",
    label: "Scale-after done",
    stage: "DELIVERED",
    severity: "INFO",
    applies: () => true,
    isDone: (l) => l.scaleAfterTask === "DONE"
  },
  {
    key: "POD_REQUESTED",
    label: "POD requested",
    stage: "DELIVERED",
    severity: "WARN",
    applies: () => true,
    isDone: (l) => l.podStatus !== null && POD_REQUESTED_STATES.has(l.podStatus)
  },
  // POD_RECEIVED — done to complete.
  {
    key: "POD_SEND_OBLIGATION",
    label: "POD sent to broker",
    stage: "POD_RECEIVED",
    severity: "WARN",
    applies: () => true,
    isDone: (l) => l.podStatus === "SENT_TO_BROKER"
  }
];

export type ChecklistItemState = "done" | "open" | "blocked";

export interface ChecklistItem {
  key: string;
  label: string;
  /** A `ChecklistStage` for load-level items, or a synthetic group key (e.g. "RELAY") for relay items. */
  stage: string;
  severity: LoadAlertSeverity;
  hardGate: boolean;
  state: ChecklistItemState;
}

export interface ChecklistStageGroup {
  /** A `ChecklistStage` for the lifecycle groups, or a synthetic key (e.g. "RELAY") for the relay group. */
  stage: string;
  label: string;
  items: ChecklistItem[];
}

export interface LoadChecklist {
  groups: ChecklistStageGroup[];
  summary: { done: number; total: number; openHard: number; openSoft: number };
}

const TERMINAL_STATUSES = new Set(["CANCELED", "FAILED", "COMPLETED"]);

const LEG_TYPE_LABELS: Record<string, string> = { SHUTTLE: "Shuttle", PTP: "PTP", DELIVERY: "Delivery" };

type RelayLeg = ChecklistLoadInput["legs"][number];

function legTypeLabel(legType?: string): string {
  if (!legType) return "Leg";
  return LEG_TYPE_LABELS[legType] ?? legType;
}

function legHasDriver(leg: RelayLeg): boolean {
  return Boolean(leg.driverName && leg.driverName.trim().length > 0);
}

/**
 * Trailer continuity across a handoff (focal point #1): satisfied when the next
 * driver's hook is explicitly confirmed, OR both legs carry the same trailer #.
 * A set-but-mismatched pair stays open (and the alert engine flags it urgent).
 */
function trailerContinuityOk(here: RelayLeg, next: RelayLeg): boolean {
  if (next.trailerHookConfirmed === "DONE") return true;
  const a = here.trailer?.trim().toUpperCase();
  const b = next.trailer?.trim().toUpperCase();
  return Boolean(a && b && a === b);
}

/**
 * The relay / custody dimension: per-leg operational items (driver, ETA,
 * arrival) plus a "baton confirmed" item per handoff between adjacent legs. The
 * count tracks the load's legs, so a direct load (0–1 leg) yields no handoff
 * items and a full 3-leg relay yields 2. All SOFT — the macro-status gate is
 * driven by the load-level `CHECKLIST_ITEMS` only, so these never block an
 * advance; they surface as accountability here and as alerts in the rail.
 */
function buildRelayGroup(load: ChecklistLoadInput): ChecklistStageGroup | null {
  const legs = [...(load.legs ?? [])].sort((a, b) => (a.legIndex ?? 0) - (b.legIndex ?? 0));
  if (legs.length === 0) return null;

  const softItem = (key: string, label: string, severity: LoadAlertSeverity, done: boolean): ChecklistItem => ({
    key,
    label,
    stage: "RELAY",
    severity,
    hardGate: false,
    state: done ? "done" : "open"
  });

  const items: ChecklistItem[] = [];
  legs.forEach((leg, i) => {
    const tag = `Leg ${i + 1} (${legTypeLabel(leg.legType)})`;
    items.push(softItem(`LEG_${i}_DRIVER`, `${tag} · driver assigned`, "WARN", legHasDriver(leg)));
    items.push(softItem(`LEG_${i}_ETA`, `${tag} · ETA captured`, "INFO", Boolean(leg.etaAtIso)));
    items.push(softItem(`LEG_${i}_ARRIVAL`, `${tag} · arrival confirmed`, "INFO", Boolean(leg.arrivalAtIso)));
    // The baton has passed when this leg has landed at the node AND the next leg
    // has a driver to carry it onward — the anti-stall confirmation.
    const next = legs[i + 1];
    if (next) {
      const passed = Boolean(leg.arrivalAtIso) && legHasDriver(next);
      items.push(softItem(`HANDOFF_${i}_${i + 1}_DEPART`, `Handoff ${i + 1}→${i + 2} · baton confirmed`, "WARN", passed));
      items.push(
        softItem(`HANDOFF_${i}_${i + 1}_TRAILER`, `Handoff ${i + 1}→${i + 2} · trailer continuity`, "WARN", trailerContinuityOk(leg, next))
      );
    }
  });

  return { stage: "RELAY", label: `Relay · ${legs.length} leg${legs.length === 1 ? "" : "s"}`, items };
}

/** Evaluate the full checklist for a load: every applicable item, grouped by stage, with done/open/blocked state. */
export function deriveLoadChecklist(load: ChecklistLoadInput): LoadChecklist {
  const empty: LoadChecklist = { groups: [], summary: { done: 0, total: 0, openHard: 0, openSoft: 0 } };
  if (TERMINAL_STATUSES.has(load.status)) return empty;

  const summary = { done: 0, total: 0, openHard: 0, openSoft: 0 };
  const byStage = new Map<ChecklistStage, ChecklistItem[]>();

  for (const def of CHECKLIST_ITEMS) {
    if (!def.applies(load)) continue;
    summary.total += 1;
    const done = def.isDone(load);
    const hardGate = Boolean(def.hardGate);
    const state: ChecklistItemState = done ? "done" : hardGate ? "blocked" : "open";
    if (done) summary.done += 1;
    else if (hardGate) summary.openHard += 1;
    else summary.openSoft += 1;

    const item: ChecklistItem = { key: def.key, label: def.label, stage: def.stage, severity: def.severity, hardGate, state };
    const list = byStage.get(def.stage) ?? [];
    list.push(item);
    byStage.set(def.stage, list);
  }

  const groups: ChecklistStageGroup[] = [];
  for (const stage of CHECKLIST_STAGES) {
    const items = byStage.get(stage);
    if (items && items.length > 0) groups.push({ stage, label: STAGE_LABELS[stage], items });
  }

  // Append the relay / custody dimension after the load-level lifecycle groups.
  // Soft items only: they count toward done/total + openSoft, never openHard.
  const relay = buildRelayGroup(load);
  if (relay) {
    for (const item of relay.items) {
      summary.total += 1;
      if (item.state === "done") summary.done += 1;
      else summary.openSoft += 1;
    }
    groups.push(relay);
  }

  return { groups, summary };
}

/** Open obligations whose stage === the status being left, split by hard vs soft — the status-gate helper. */
export function stageExitObligations(
  load: ChecklistLoadInput,
  leavingStatus: string
): { hardOpen: { key: string; label: string }[]; softOpen: { key: string; label: string }[] } {
  const hardOpen: { key: string; label: string }[] = [];
  const softOpen: { key: string; label: string }[] = [];
  for (const def of CHECKLIST_ITEMS) {
    if (def.stage !== leavingStatus) continue;
    if (!def.applies(load) || def.isDone(load)) continue;
    (def.hardGate ? hardOpen : softOpen).push({ key: def.key, label: def.label });
  }
  return { hardOpen, softOpen };
}
