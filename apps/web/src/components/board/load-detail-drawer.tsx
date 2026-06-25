"use client";

import React from "react";
import { CheckIcon, CloseIcon } from "@/components/icons";
import type { ViewBoardLoadRow } from "@/lib/ui/board-mappers";
import type { LoadDetailResponse, ViewLoadDetail } from "@/lib/ui/drawer-mappers";
import { mapLoadDetailToView } from "@/lib/ui/drawer-mappers";
import { deriveLoadChecklist } from "@/lib/ui/load-checklist";
import { money, miles, pct, rpm } from "@/lib/ui/formatters";
import { StatusPill } from "./status-pill";

type LoadLifecycleStatus =
  | "BOOKED"
  | "DISPATCHED"
  | "PICKED_UP"
  | "DELIVERED"
  | "POD_RECEIVED"
  | "COMPLETED"
  | "CANCELED"
  | "FAILED";

/** Forward lifecycle stages a coordinator advances a load through, in order. */
const LIFECYCLE_STAGES: LoadLifecycleStatus[] = [
  "BOOKED",
  "DISPATCHED",
  "PICKED_UP",
  "DELIVERED",
  "POD_RECEIVED",
  "COMPLETED"
];

interface LoadDetailDrawerProps {
  loadId: string | null;
  regionId: string;
  fallbackLoad?: ViewBoardLoadRow | null;
  onClose: () => void;
  onSetStatus?: (loadId: string, status: LoadLifecycleStatus, overrideReason?: string) => Promise<void>;
  onUpdateFields?: (loadId: string, fields: any) => Promise<void>;
  onUpsertLeg?: (
    loadId: string,
    leg: {
      id?: string;
      legIndex: number;
      legType: "SHUTTLE" | "PTP" | "DELIVERY";
      driverName?: string | null;
      startCity?: string | null;
      startState?: string | null;
      endCity?: string | null;
      endState?: string | null;
      legMiles?: string | null;
      notes?: string | null;
      etaAt?: string | null;
      arrivalAt?: string | null;
      trailer?: string | null;
      trailerHookConfirmed?: "NOT_DONE" | "DONE";
    }
  ) => Promise<void>;
  onDeleteLeg?: (loadId: string, legId: string) => Promise<void>;
  onRescheduleDelivery?: (
    loadId: string,
    appt: {
      newDate: string;
      windowStart: string;
      windowEnd: string;
      apptType: "FIRM_APPT" | "OPEN_WINDOW" | "FCFS";
    }
  ) => Promise<void>;
}

interface ApiErrorPayload {
  error?: string;
}

/** ISO timestamp → a `datetime-local` input value ("YYYY-MM-DDTHH:MM") in the coordinator's local clock. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` input value (local clock) → an ISO timestamp, or null when blank. */
function localInputToIso(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO timestamp → a short local display string ("Jun 21, 2:30 PM"), or "" when absent. */
function isoToLocalDisplay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function buildFallbackDetail(load: ViewBoardLoadRow): ViewLoadDetail {
  const nowIso = new Date().toISOString();
  const puDh = load.puDh ?? 0;
  const delDh = load.delDh ?? 0;
  const totalMi = load.totalMi;
  const emptyPctRatio = totalMi && totalMi > 0 ? (puDh + delDh) / totalMi : null;
  const nbyRatio = totalMi && totalMi > 0 ? (load.lineHaul ?? 0) / totalMi : null;

  const response: LoadDetailResponse = {
    id: load.id,
    status: load.status,
    sectionCode: load.dropLotName ?? null,
    threePlRefNumber: load.ref === "—" ? null : load.ref,
    routeId: load.routeId,
    loadNumber: load.loadNumber,
    pickupNumber: load.pickupNumber,
    pickupNumbers: load.pickupNumbers ?? [],
    shipperName: load.shipper === "—" ? null : load.shipper,
    pickupCityState: load.pickupCityState,
    pickupWindow: load.pickupWindow,
    receiverName: load.receiver === "—" ? null : load.receiver,
    deliveryCityState: load.deliveryCityState,
    deliveryWindow: load.deliveryWindow,
    lineHaulRate: String(load.lineHaul ?? 0),
    loadedMiles: String(load.loadedMi ?? 0),
    puDeadheadMiles: String(load.puDh ?? 0),
    delDeadheadMiles: String(load.delDh ?? 0),
    totalTripMiles: load.totalMi === null ? null : String(load.totalMi),
    negotiableMiles: load.negMi === null ? null : String(load.negMi),
    loadedRpm: load.loadedRpm === null ? null : String(load.loadedRpm),
    emptyMilePct: emptyPctRatio === null ? null : String(emptyPctRatio),
    nby: nbyRatio === null ? null : String(nbyRatio),
    brokerName: load.brokerName,
    pickupDriverAssigned: load.pickupDriverAssigned,
    tractorTrailer1: load.tractorTrailer1,
    tractorTrailer2: load.tractorTrailer2,
    commodity: load.commodity,
    equipmentNeeds: load.equipmentNeeds,
    mgStatus: null,
    tmwStatus: null,
    mgStatusTask: load.mgStatusTask,
    tmwStatusTask: load.tmwStatusTask,
    scaleBeforeTask: load.scaleBeforeTask,
    scaleAfterTask: load.scaleAfterTask,
    bolMatchTask: load.bolMatchTask,
    pickupEtaAdvised: load.pickupEtaAdvised,
    pickupArrivalAdvised: load.pickupArrivalAdvised,
    deliveryEtaAdvised: load.deliveryEtaAdvised,
    deliveryArrivalAdvised: load.deliveryArrivalAdvised,
    deliveryExceptionState: load.deliveryExceptionState,
    rescheduleDriverConfirmed: load.rescheduleDriverConfirmed,
    coordinatorNotes: load.coordinatorNotes,
    attentionNote: load.lateCancelFailedNote,
    attentionSeverity: load.attentionSeverity,
    driverType: load.driverType,
    podStatus: load.podStatus,
    rateConfirmation: load.rateConfirmationId
      ? {
          id: load.rateConfirmationId,
          sourceFileUrl: "#",
          parseState: "EXTRACTED",
          parseConfidence: null
        }
      : null,
    legs: (load.legs ?? []).map((leg) => ({
      id: leg.id,
      legIndex: leg.legIndex,
      legType: leg.legType,
      driverName: leg.driverName,
      startCity: leg.startCity,
      startState: leg.startState,
      endCity: leg.endCity,
      endState: leg.endState,
      legMiles: leg.legMiles === null ? null : String(leg.legMiles),
      notes: leg.notes,
      etaAtIso: leg.etaAtIso,
      arrivalAtIso: leg.arrivalAtIso,
      trailer: leg.trailer,
      trailerHookConfirmed: leg.trailerHookConfirmed
    })),
    createdAt: nowIso,
    updatedAt: nowIso,
    createdByName: null,
    lastUpdatedByName: null,
    lastUpdatedAction: null
  };

  return mapLoadDetailToView(response);
}

const STAGE_LABELS: Record<string, string> = {
  BOOKED: "Booked",
  DISPATCHED: "Dispatched",
  PICKED_UP: "Picked up",
  DELIVERED: "Delivered",
  POD_RECEIVED: "POD recv",
  COMPLETED: "Completed"
};

function Timeline({ timeline }: Pick<ViewLoadDetail, "timeline">) {
  return (
    <div className="db-timeline">
      {timeline.map((step, index) => (
        <React.Fragment key={step.key}>
          <div className={`db-tl-step ${step.state}`}>
            <div className="db-tl-dot">{step.state === "done" ? <CheckIcon size={9} /> : null}</div>
            <div className="db-tl-label">{STAGE_LABELS[step.key] ?? step.key.replaceAll("_", " ")}</div>
          </div>
          {index < timeline.length - 1 ? (
            <div className={`db-tl-bar${step.state === "done" ? " done" : ""}`} />
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}

function KV({
  label,
  value,
  mono,
  strong,
  accent
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="db-kv">
      <div className="db-kv-k">{label}</div>
      <div className={`db-kv-v${mono ? " mono" : ""}${strong ? " strong" : ""}${accent ? " accent" : ""}`}>{value}</div>
    </div>
  );
}

function Section({
  title,
  kicker,
  children
}: {
  title: string;
  kicker?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="db-drawer-section">
      <header className="db-drawer-section-head">
        <span className="db-drawer-section-title">{title}</span>
        {kicker ? <span className="db-drawer-section-kicker mono">{kicker}</span> : null}
      </header>
      <div className="db-drawer-section-body">{children}</div>
    </section>
  );
}

function RateconDocIcon() {
  return (
    <svg width="22" height="26" viewBox="0 0 28 32" fill="none" aria-hidden="true">
      <path d="M3 2h14l8 8v20H3V2z" stroke="var(--db-fg-mid)" strokeWidth="1.2" />
      <path d="M17 2v8h8" stroke="var(--db-fg-mid)" strokeWidth="1.2" />
      <path d="M7 16h14M7 20h14M7 24h10" stroke="var(--db-fg-dim)" strokeWidth="1" />
    </svg>
  );
}

export function LoadDetailDrawer({
  loadId,
  regionId,
  fallbackLoad = null,
  onClose,
  onSetStatus,
  onUpdateFields,
  onUpsertLeg,
  onDeleteLeg,
  onRescheduleDelivery
}: LoadDetailDrawerProps) {
  const [detail, setDetail] = React.useState<ViewLoadDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  // Set when a forward status advance is blocked by open soft obligations — prompts for an override reason.
  const [overridePrompt, setOverridePrompt] = React.useState<{ status: LoadLifecycleStatus; openItems: string[] } | null>(null);
  const [overrideReason, setOverrideReason] = React.useState("");
  // Managed checklist derived from the board row (kept fresh as edits refresh the board).
  const checklist = React.useMemo(() => (fallbackLoad ? deriveLoadChecklist(fallbackLoad) : null), [fallbackLoad]);
  const [editing, setEditing] = React.useState(false);
  const [rcPreviewOpen, setRcPreviewOpen] = React.useState(false);
  const [formState, setFormState] = React.useState({
    mgStatusTask: "NOT_DONE",
    tmwStatusTask: "NOT_DONE",
    scaleBeforeTask: "NOT_DONE",
    scaleAfterTask: "NOT_DONE",
    bolMatchTask: "NOT_DONE",
    pickupEtaAdvised: "NOT_DONE",
    pickupArrivalAdvised: "NOT_DONE",
    deliveryEtaAdvised: "NOT_DONE",
    deliveryArrivalAdvised: "NOT_DONE",
    deliveryExceptionState: "NONE",
    rescheduleDriverConfirmed: "NOT_DONE",
    pickupDriverAssigned: "",
    commodity: "",
    equipmentNeeds: "",
    podStatus: "",
    driverType: "",
    pickupWindow: "",
    deliveryWindow: "",
    attentionSeverity: "INFO",
    attentionNote: "",
    coordinatorNotes: ""
  });
  // Transient inputs for the structured delivery-reschedule mini-form (not part
  // of the batched operational save — they feed the dedicated reschedule action).
  const [rescheduleForm, setRescheduleForm] = React.useState({
    date: "",
    windowStart: "",
    windowEnd: "",
    apptType: "FIRM_APPT"
  });
  const [legForm, setLegForm] = React.useState({
    id: "",
    legIndex: "1",
    legType: "PTP",
    driverName: "",
    startCity: "",
    startState: "",
    endCity: "",
    endState: "",
    legMiles: "",
    notes: "",
    etaAt: "",
    arrivalAt: "",
    trailer: "",
    trailerHookConfirmed: false
  });
  const drawerRef = React.useRef<HTMLElement | null>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const previousLoadIdRef = React.useRef<string | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    if (!loadId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      setSaving(false);
      setSaveError(null);
      setSaveMessage(null);
      setEditing(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/board/load/${loadId}?regionId=${encodeURIComponent(regionId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
          throw new Error(payload?.error ?? "Unable to load details.");
        }
        return response.json();
      })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setDetail(mapLoadDetailToView(payload));
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        if (fallbackLoad && fallbackLoad.id === loadId) {
          setDetail(buildFallbackDetail(fallbackLoad));
          setError(null);
          return;
        }
        setError(err instanceof Error ? err.message : "Unable to load details.");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fallbackLoad, loadId, regionId, reloadNonce]);

  React.useEffect(() => {
    if (!detail) {
      return;
    }
    const dashToEmpty = (value: string) => (value === "—" ? "" : value);
    setFormState({
      mgStatusTask: detail.operations.mgStatusTask === "DONE" ? "DONE" : "NOT_DONE",
      tmwStatusTask: detail.operations.tmwStatusTask === "DONE" ? "DONE" : "NOT_DONE",
      scaleBeforeTask: detail.operations.scaleBeforeTask === "DONE" ? "DONE" : "NOT_DONE",
      scaleAfterTask: detail.operations.scaleAfterTask === "DONE" ? "DONE" : "NOT_DONE",
      bolMatchTask: detail.operations.bolMatchTask === "DONE" ? "DONE" : "NOT_DONE",
      pickupEtaAdvised: detail.operations.pickupEtaAdvised === "DONE" ? "DONE" : "NOT_DONE",
      pickupArrivalAdvised: detail.operations.pickupArrivalAdvised === "DONE" ? "DONE" : "NOT_DONE",
      deliveryEtaAdvised: detail.operations.deliveryEtaAdvised === "DONE" ? "DONE" : "NOT_DONE",
      deliveryArrivalAdvised: detail.operations.deliveryArrivalAdvised === "DONE" ? "DONE" : "NOT_DONE",
      deliveryExceptionState: ["NONE", "WORK_IN_REQUESTED", "RESCHEDULED"].includes(detail.operations.deliveryExceptionState)
        ? detail.operations.deliveryExceptionState
        : "NONE",
      rescheduleDriverConfirmed: detail.operations.rescheduleDriverConfirmed === "DONE" ? "DONE" : "NOT_DONE",
      pickupDriverAssigned: dashToEmpty(detail.operations.pickupDriverAssigned),
      commodity: dashToEmpty(detail.operations.commodity),
      equipmentNeeds: dashToEmpty(detail.operations.equipmentNeeds),
      podStatus: dashToEmpty(detail.operations.podStatus),
      driverType: dashToEmpty(detail.operations.driverType),
      pickupWindow: dashToEmpty(detail.geography.pickupWindow),
      deliveryWindow: dashToEmpty(detail.geography.deliveryWindow),
      attentionSeverity: ["INFO", "WARN", "URGENT"].includes(detail.operations.attentionSeverity)
        ? detail.operations.attentionSeverity
        : "INFO",
      attentionNote: dashToEmpty(detail.operations.attentionNote),
      coordinatorNotes: dashToEmpty(detail.operations.coordinatorNotes)
    });
    setSaveError(null);
    setSaveMessage(null);
  }, [detail]);

  React.useEffect(() => {
    const wasOpen = previousLoadIdRef.current !== null;
    const isOpen = loadId !== null;

    if (isOpen && !wasOpen) {
      setEditing(false);
      setRcPreviewOpen(false);
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const focusFrame = window.requestAnimationFrame(() => {
        closeButtonRef.current?.focus();
      });
      previousLoadIdRef.current = loadId;
      return () => {
        window.cancelAnimationFrame(focusFrame);
      };
    }

    if (!isOpen && wasOpen) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      const restoreFrame = window.requestAnimationFrame(() => {
        target?.focus();
      });
      previousLoadIdRef.current = null;
      return () => {
        window.cancelAnimationFrame(restoreFrame);
      };
    }

    previousLoadIdRef.current = loadId;
  }, [loadId]);

  const handleDialogKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const drawer = drawerRef.current;
      if (!drawer) {
        return;
      }

      const focusableElements = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
        )
      ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");

      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

      if (event.shiftKey) {
        if (!activeElement || activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        }
        return;
      }

      if (activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    },
    [onClose]
  );

  const applyStatus = React.useCallback(
    async (status: LoadLifecycleStatus, reason?: string) => {
      if (!loadId || !onSetStatus) {
        return;
      }
      setSaving(true);
      setSaveError(null);
      setSaveMessage(null);
      try {
        await onSetStatus(loadId, status, reason);
        setSaveMessage(`Status updated to ${status}.`);
        setOverridePrompt(null);
        setOverrideReason("");
        setReloadNonce((value) => value + 1);
      } catch (err) {
        const gate = err as { needsOverrideReason?: boolean; openItems?: string[] };
        if (gate?.needsOverrideReason) {
          // Soft gate — open items remain; ask for a reason rather than failing outright.
          setOverridePrompt({ status, openItems: gate.openItems ?? [] });
          setOverrideReason("");
        } else {
          setSaveError(err instanceof Error ? err.message : "Status update failed.");
        }
      } finally {
        setSaving(false);
      }
    },
    [loadId, onSetStatus]
  );

  // Persist a single field immediately (used by the check-off toggles) so
  // addressing an alert updates the board's Needs Attention rail right away,
  // without waiting for "Save changes".
  const commitField = React.useCallback(
    async (patch: Record<string, string>) => {
      setFormState((prev) => ({ ...prev, ...patch }));
      if (!loadId || !onUpdateFields) {
        return;
      }
      setSaving(true);
      setSaveError(null);
      setSaveMessage(null);
      try {
        await onUpdateFields(loadId, patch);
        setSaveMessage("Saved.");
        setReloadNonce((value) => value + 1);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Update failed.");
      } finally {
        setSaving(false);
      }
    },
    [loadId, onUpdateFields]
  );

  const saveOperationalFields = React.useCallback(async () => {
    if (!loadId || !onUpdateFields) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await onUpdateFields(loadId, {
        mgStatusTask: formState.mgStatusTask,
        tmwStatusTask: formState.tmwStatusTask,
        scaleBeforeTask: formState.scaleBeforeTask,
        scaleAfterTask: formState.scaleAfterTask,
        bolMatchTask: formState.bolMatchTask,
        pickupEtaAdvised: formState.pickupEtaAdvised,
        pickupArrivalAdvised: formState.pickupArrivalAdvised,
        deliveryEtaAdvised: formState.deliveryEtaAdvised,
        deliveryArrivalAdvised: formState.deliveryArrivalAdvised,
        deliveryExceptionState: formState.deliveryExceptionState,
        rescheduleDriverConfirmed: formState.rescheduleDriverConfirmed,
        pickupDriverAssigned: formState.pickupDriverAssigned.trim() || null,
        commodity: formState.commodity.trim() || null,
        equipmentNeeds: formState.equipmentNeeds.trim() || null,
        podStatus: formState.podStatus.trim() || null,
        driverType: formState.driverType.trim() || null,
        pickupWindow: formState.pickupWindow.trim() || null,
        deliveryWindow: formState.deliveryWindow.trim() || null,
        attentionSeverity: formState.attentionSeverity,
        attentionNote: formState.attentionNote.trim() || null,
        coordinatorNotes: formState.coordinatorNotes.trim() || null
      });
      setSaveMessage("Operational fields saved.");
      setReloadNonce((value) => value + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Field update failed.");
    } finally {
      setSaving(false);
    }
  }, [formState, loadId, onUpdateFields]);

  const resetLegForm = React.useCallback(() => {
    setLegForm({
      id: "",
      legIndex: "1",
      legType: "PTP",
      driverName: "",
      startCity: "",
      startState: "",
      endCity: "",
      endState: "",
      legMiles: "",
      notes: "",
      etaAt: "",
      arrivalAt: "",
      trailer: "",
      trailerHookConfirmed: false
    });
  }, []);

  const editLeg = React.useCallback((leg: ViewLoadDetail["legs"][number]) => {
    setLegForm({
      id: leg.id,
      legIndex: String(leg.legIndex),
      legType: (leg.legType === "SHUTTLE" || leg.legType === "PTP" || leg.legType === "DELIVERY" ? leg.legType : "PTP") as
        | "SHUTTLE"
        | "PTP"
        | "DELIVERY",
      driverName: leg.driverName === "—" ? "" : leg.driverName,
      startCity: leg.start === "—" ? "" : leg.start.split(",")[0]?.trim() ?? "",
      startState: leg.start === "—" ? "" : leg.start.split(",")[1]?.trim() ?? "",
      endCity: leg.end === "—" ? "" : leg.end.split(",")[0]?.trim() ?? "",
      endState: leg.end === "—" ? "" : leg.end.split(",")[1]?.trim() ?? "",
      legMiles: leg.legMiles === null ? "" : String(leg.legMiles),
      notes: leg.notes === "—" ? "" : leg.notes,
      etaAt: isoToLocalInput(leg.etaAtIso),
      arrivalAt: isoToLocalInput(leg.arrivalAtIso),
      trailer: leg.trailer === "—" ? "" : leg.trailer,
      trailerHookConfirmed: leg.trailerHookConfirmed
    });
  }, []);

  const saveLeg = React.useCallback(async () => {
    if (!loadId || !onUpsertLeg) {
      return;
    }
    const parsedIndex = Number.parseInt(legForm.legIndex, 10);
    if (!Number.isFinite(parsedIndex) || parsedIndex <= 0) {
      setSaveError("Leg index must be a positive number.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await onUpsertLeg(loadId, {
        id: legForm.id || undefined,
        legIndex: parsedIndex,
        legType: legForm.legType as "SHUTTLE" | "PTP" | "DELIVERY",
        driverName: legForm.driverName.trim() || null,
        startCity: legForm.startCity.trim() || null,
        startState: legForm.startState.trim() || null,
        endCity: legForm.endCity.trim() || null,
        endState: legForm.endState.trim() || null,
        legMiles: legForm.legMiles.trim() || null,
        notes: legForm.notes.trim() || null,
        etaAt: localInputToIso(legForm.etaAt),
        arrivalAt: localInputToIso(legForm.arrivalAt),
        trailer: legForm.trailer.trim() || null,
        trailerHookConfirmed: legForm.trailerHookConfirmed ? "DONE" : "NOT_DONE"
      });
      setSaveMessage(legForm.id ? "Leg updated." : "Leg added.");
      resetLegForm();
      setReloadNonce((value) => value + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Leg save failed.");
    } finally {
      setSaving(false);
    }
  }, [legForm, loadId, onUpsertLeg, resetLegForm]);

  const removeLeg = React.useCallback(
    async (legId: string) => {
      if (!loadId || !onDeleteLeg) {
        return;
      }
      setSaving(true);
      setSaveError(null);
      setSaveMessage(null);
      try {
        await onDeleteLeg(loadId, legId);
        if (legForm.id === legId) {
          resetLegForm();
        }
        setSaveMessage("Leg deleted.");
        setReloadNonce((value) => value + 1);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Leg delete failed.");
      } finally {
        setSaving(false);
      }
    },
    [legForm.id, loadId, onDeleteLeg, resetLegForm]
  );

  const saveReschedule = React.useCallback(async () => {
    if (!loadId || !onRescheduleDelivery) {
      return;
    }
    if (!rescheduleForm.date || !rescheduleForm.windowStart || !rescheduleForm.windowEnd) {
      setSaveError("New date, start, and end are required to reschedule.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await onRescheduleDelivery(loadId, {
        newDate: rescheduleForm.date,
        windowStart: rescheduleForm.windowStart,
        windowEnd: rescheduleForm.windowEnd,
        apptType: rescheduleForm.apptType as "FIRM_APPT" | "OPEN_WINDOW" | "FCFS"
      });
      setSaveMessage("Delivery rescheduled.");
      setRescheduleForm({ date: "", windowStart: "", windowEnd: "", apptType: "FIRM_APPT" });
      setReloadNonce((value) => value + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Reschedule failed.");
    } finally {
      setSaving(false);
    }
  }, [loadId, onRescheduleDelivery, rescheduleForm]);

  if (!loadId) {
    return null;
  }

  return (
    <>
      <div className="db-drawer-backdrop" role="presentation" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="db-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="db-drawer-head">
          <div className="db-drawer-head-left">
            <div className="db-drawer-eyebrow mono">LOAD · {detail?.section ?? "—"}</div>
            <h2 id={titleId} className="db-drawer-title mono">
              {detail?.ref ?? "Loading..."}
            </h2>
          </div>
          <div className="db-drawer-head-actions">
            {detail ? (
              <button
                className="db-btn db-btn-mini db-btn-ghost"
                type="button"
                onClick={() => setEditing((value) => !value)}
                aria-pressed={editing}
              >
                {editing ? "Done" : "Edit"}
              </button>
            ) : null}
            <button ref={closeButtonRef} className="db-btn db-btn-ghost" onClick={onClose} aria-label="Close load details">
              <CloseIcon size={14} />
            </button>
          </div>
        </header>
        {detail ? (
          <div className="db-drawer-meta">
            <StatusPill status={detail.status} />
            <span className="db-drawer-meta-sep" />
            <span className="dim">Route</span>
            <span className="mono">{detail.ids.routeId}</span>
            {detail.ids.pickupNumber !== "—" ? (
              <>
                <span className="db-drawer-meta-sep" />
                <span className="dim">PU</span>
                <span className="mono">{detail.ids.pickupNumber}</span>
              </>
            ) : null}
          </div>
        ) : null}
        {loading ? (
          <div className="db-drawer-block">
            <div className="db-drawer-skeleton-title db-skel">Loading details</div>
            <div className="db-drawer-skeleton-row db-skel">Timeline placeholder</div>
            <div className="db-drawer-skeleton-row db-skel">Financials placeholder</div>
            <div className="db-drawer-skeleton-row db-skel">Operations placeholder</div>
          </div>
        ) : null}
        {error ? <p className="db-drawer-block">{error}</p> : null}
        {!loading && !error && detail ? (
          <div className="db-drawer-body">
            {editing ? (
            <Section title="Edit · status & operations">
              <div className="db-field-label" style={{ marginBottom: 4 }}>Lifecycle status</div>
              <div className="db-status-ladder">
                {LIFECYCLE_STAGES.map((stage) => {
                  const current = detail.status === stage;
                  return (
                    <button
                      key={stage}
                      type="button"
                      className={`db-btn db-btn-mini${current ? " db-btn-active" : ""}`}
                      aria-pressed={current}
                      disabled={saving || current}
                      onClick={() => void applyStatus(stage)}
                    >
                      {STAGE_LABELS[stage] ?? stage}
                    </button>
                  );
                })}
              </div>
              <div className="db-row-with-actions db-drawer-actions-row">
                <button className="db-btn db-btn-mini db-btn-ghost" type="button" disabled={saving} onClick={() => void applyStatus("CANCELED")}>
                  Mark Canceled
                </button>
                <button className="db-btn db-btn-mini db-btn-ghost" type="button" disabled={saving} onClick={() => void applyStatus("FAILED")}>
                  Mark Failed
                </button>
              </div>
              {overridePrompt ? (
                <div className="db-override-prompt">
                  <p className="db-override-title">
                    Open items before {STAGE_LABELS[overridePrompt.status] ?? overridePrompt.status}:
                  </p>
                  <ul className="db-override-items">
                    {overridePrompt.openItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <label className="db-field-label">
                    Override reason
                    <input
                      className="db-input"
                      value={overrideReason}
                      placeholder="e.g. broker notified by phone"
                      onChange={(e) => setOverrideReason(e.target.value)}
                    />
                  </label>
                  <div className="db-row-with-actions db-drawer-actions-row">
                    <button
                      className="db-btn db-btn-mini"
                      type="button"
                      disabled={saving || !overrideReason.trim()}
                      onClick={() => void applyStatus(overridePrompt.status, overrideReason.trim())}
                    >
                      Advance with reason
                    </button>
                    <button
                      className="db-btn db-btn-mini db-btn-ghost"
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setOverridePrompt(null);
                        setOverrideReason("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {/* Edit fields grouped by the lifecycle point they belong to (mirrors the Checklist). */}
              <div className="db-edit-stage">
                <div className="db-edit-stage-head">Booked</div>
                <div className="db-drawer-form-grid">
                  <label className="db-field-label">
                    Driver Assigned
                    <input className="db-input" value={formState.pickupDriverAssigned} onChange={(e) => setFormState((s) => ({ ...s, pickupDriverAssigned: e.target.value }))} />
                  </label>
                  <label className="db-field-label">
                    Driver Type
                    <select className="db-input" value={formState.driverType} onChange={(e) => setFormState((s) => ({ ...s, driverType: e.target.value }))}>
                      <option value="">—</option>
                      <option value="SHUTTLE">SHUTTLE</option>
                      <option value="PTP">PTP</option>
                      <option value="LTL">LTL</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="db-edit-stage">
                <div className="db-edit-stage-head">Dispatched</div>
                <div className="db-drawer-form-grid">
                  <label className="db-field-label">
                    MG Task
                    <select className="db-input" value={formState.mgStatusTask} onChange={(e) => void commitField({ mgStatusTask: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                  <label className="db-field-label">
                    TMW Task
                    <select className="db-input" value={formState.tmwStatusTask} onChange={(e) => void commitField({ tmwStatusTask: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                  <label className="db-field-label">
                    Advised PU ETA
                    <select className="db-input" value={formState.pickupEtaAdvised} onChange={(e) => void commitField({ pickupEtaAdvised: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="db-edit-stage">
                <div className="db-edit-stage-head">Picked up</div>
                <div className="db-drawer-form-grid">
                  <label className="db-field-label">
                    BOL matches RC
                    <select className="db-input" value={formState.bolMatchTask} onChange={(e) => void commitField({ bolMatchTask: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                  <label className="db-field-label">
                    Advised PU arrival
                    <select className="db-input" value={formState.pickupArrivalAdvised} onChange={(e) => void commitField({ pickupArrivalAdvised: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                  <label className="db-field-label">
                    Advised DEL ETA
                    <select className="db-input" value={formState.deliveryEtaAdvised} onChange={(e) => void commitField({ deliveryEtaAdvised: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                  <label className="db-field-label">
                    Scale Before
                    <select className="db-input" value={formState.scaleBeforeTask} onChange={(e) => void commitField({ scaleBeforeTask: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="db-edit-stage">
                <div className="db-edit-stage-head">Delivered</div>
                <div className="db-drawer-form-grid">
                  <label className="db-field-label">
                    Advised DEL arrival
                    <select className="db-input" value={formState.deliveryArrivalAdvised} onChange={(e) => void commitField({ deliveryArrivalAdvised: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                  <label className="db-field-label">
                    Scale After
                    <select className="db-input" value={formState.scaleAfterTask} onChange={(e) => void commitField({ scaleAfterTask: e.target.value })}>
                      <option value="NOT_DONE">NOT_DONE</option>
                      <option value="DONE">DONE</option>
                    </select>
                  </label>
                  <label className="db-field-label">
                    POD Status
                    <select className="db-input" value={formState.podStatus} onChange={(e) => void commitField({ podStatus: e.target.value })}>
                      <option value="">—</option>
                      <option value="NOT_REQUESTED">NOT_REQUESTED</option>
                      <option value="REQUESTED">REQUESTED</option>
                      <option value="UPLOADED">UPLOADED</option>
                      <option value="SENT_TO_BROKER">SENT_TO_BROKER</option>
                      <option value="NEEDS_ATTENTION">NEEDS_ATTENTION</option>
                    </select>
                  </label>
                </div>
                <div className="db-field-label db-drawer-form-full" style={{ marginTop: 6 }}>
                  Delivery exception
                  <div className="db-row-with-actions" style={{ marginTop: 4 }}>
                    <span className="dim mono" style={{ alignSelf: "center" }}>
                      {formState.deliveryExceptionState === "WORK_IN_REQUESTED"
                        ? "Work-in requested"
                        : formState.deliveryExceptionState === "RESCHEDULED"
                          ? "Rescheduled"
                          : "None"}
                    </span>
                    <button
                      className={`db-btn db-btn-mini${formState.deliveryExceptionState === "WORK_IN_REQUESTED" ? " db-btn-active" : ""}`}
                      type="button"
                      disabled={saving}
                      onClick={() => void commitField({ deliveryExceptionState: "WORK_IN_REQUESTED" })}
                    >
                      Mark work-in
                    </button>
                    <button
                      className="db-btn db-btn-mini db-btn-ghost"
                      type="button"
                      disabled={saving || formState.deliveryExceptionState === "NONE"}
                      onClick={() => void commitField({ deliveryExceptionState: "NONE" })}
                    >
                      Clear
                    </button>
                  </div>
                  {formState.deliveryExceptionState === "RESCHEDULED" ? (
                    <label className="db-field-label" style={{ marginTop: 6 }}>
                      Next-day driver assigned
                      <select
                        className="db-input"
                        value={formState.rescheduleDriverConfirmed}
                        onChange={(e) => void commitField({ rescheduleDriverConfirmed: e.target.value })}
                      >
                        <option value="NOT_DONE">NOT_DONE</option>
                        <option value="DONE">DONE</option>
                      </select>
                    </label>
                  ) : null}
                  {onRescheduleDelivery ? (
                    <div className="db-drawer-form-grid" style={{ marginTop: 6 }}>
                      <label className="db-field-label">
                        New delivery date
                        <input
                          className="db-input"
                          type="date"
                          value={rescheduleForm.date}
                          onChange={(e) => setRescheduleForm((s) => ({ ...s, date: e.target.value }))}
                        />
                      </label>
                      <label className="db-field-label">
                        Appt type
                        <select
                          className="db-input"
                          value={rescheduleForm.apptType}
                          onChange={(e) => setRescheduleForm((s) => ({ ...s, apptType: e.target.value }))}
                        >
                          <option value="FIRM_APPT">FIRM_APPT</option>
                          <option value="OPEN_WINDOW">OPEN_WINDOW</option>
                          <option value="FCFS">FCFS</option>
                        </select>
                      </label>
                      <label className="db-field-label">
                        Window start
                        <input
                          className="db-input"
                          type="time"
                          value={rescheduleForm.windowStart}
                          onChange={(e) => setRescheduleForm((s) => ({ ...s, windowStart: e.target.value }))}
                        />
                      </label>
                      <label className="db-field-label">
                        Window end
                        <input
                          className="db-input"
                          type="time"
                          value={rescheduleForm.windowEnd}
                          onChange={(e) => setRescheduleForm((s) => ({ ...s, windowEnd: e.target.value }))}
                        />
                      </label>
                      <div className="db-row-with-actions db-drawer-form-full">
                        <button className="db-btn db-btn-mini" type="button" disabled={saving} onClick={() => void saveReschedule()}>
                          Save new appointment
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="db-edit-stage">
                <div className="db-edit-stage-head">Load details</div>
                <div className="db-drawer-form-grid">
                  <label className="db-field-label">
                    Attention Severity
                    <select className="db-input" value={formState.attentionSeverity} onChange={(e) => setFormState((s) => ({ ...s, attentionSeverity: e.target.value }))}>
                      <option value="INFO">INFO</option>
                      <option value="WARN">WARN</option>
                      <option value="URGENT">URGENT</option>
                    </select>
                  </label>
                  <label className="db-field-label">
                    Commodity
                    <input className="db-input" value={formState.commodity} onChange={(e) => setFormState((s) => ({ ...s, commodity: e.target.value }))} />
                  </label>
                  <label className="db-field-label">
                    Equipment Needs
                    <input className="db-input" value={formState.equipmentNeeds} onChange={(e) => setFormState((s) => ({ ...s, equipmentNeeds: e.target.value }))} />
                  </label>
                  <label className="db-field-label">
                    Pickup Window
                    <input className="db-input" value={formState.pickupWindow} placeholder="e.g. 08:00–12:00" onChange={(e) => setFormState((s) => ({ ...s, pickupWindow: e.target.value }))} />
                  </label>
                  <label className="db-field-label">
                    Delivery Window
                    <input className="db-input" value={formState.deliveryWindow} placeholder="e.g. 00:01–09:30 (reschedule here)" onChange={(e) => setFormState((s) => ({ ...s, deliveryWindow: e.target.value }))} />
                  </label>
                  <label className="db-field-label db-drawer-form-full">
                    Attention Note
                    <textarea className="db-input" rows={2} value={formState.attentionNote} onChange={(e) => setFormState((s) => ({ ...s, attentionNote: e.target.value }))} />
                  </label>
                  <label className="db-field-label db-drawer-form-full">
                    Coordinator Notes
                    <textarea className="db-input" rows={3} value={formState.coordinatorNotes} onChange={(e) => setFormState((s) => ({ ...s, coordinatorNotes: e.target.value }))} />
                  </label>
                </div>
              </div>
              <div className="db-row-with-actions db-drawer-actions-row">
                <button className="db-btn" type="button" disabled={saving} aria-busy={saving} onClick={() => void saveOperationalFields()}>
                  {saving ? "Saving..." : "Save changes"}
                </button>
                {saveMessage ? <span className="dim">{saveMessage}</span> : null}
                {saveError ? <span className="db-upload-error">{saveError}</span> : null}
              </div>
            </Section>
            ) : null}

            <Section title="Identifiers">
              <div className="db-kv-grid">
                <KV label="3PL REF #" value={detail.ref} mono />
                <KV label="ROUTE ID #" value={detail.ids.routeId} mono />
                <KV label="LD #" value={detail.ids.loadNumber} mono />
                <KV label="PICK UP #" value={detail.ids.pickupNumber} mono />
              </div>
              {detail.ids.pickupNumbers.length > 1 ? (
                <p className="dim" style={{ marginTop: 8, fontSize: 11 }}>
                  PU list: {detail.ids.pickupNumbers.join(", ")}
                </p>
              ) : null}
            </Section>

            <Section title="Status timeline">
              <Timeline timeline={detail.timeline} />
            </Section>

            {checklist && checklist.summary.total > 0 ? (
              <Section title="Checklist">
                <div className="db-checklist">
                  <div className={`db-cl-meter${checklist.summary.openHard > 0 ? " has-hard" : ""}`}>
                    {checklist.summary.done} / {checklist.summary.total} done
                    {checklist.summary.openHard > 0 ? " · coverage required to dispatch" : ""}
                  </div>
                  {checklist.groups.map((group) => (
                    <div key={group.stage} className="db-cl-group">
                      <div className="db-cl-stage">{group.label}</div>
                      <ul className="db-cl-items">
                        {group.items.map((item) => (
                          <li key={item.key}>
                            <button
                              type="button"
                              className={`db-cl-item ${item.state} sev-${item.severity.toLowerCase()}`}
                              disabled={item.state === "done"}
                              onClick={() => setEditing(true)}
                              title={item.state === "done" ? "Done" : "Open the editor to address this"}
                            >
                              <span className={`db-cl-glyph ${item.state}`}>
                                {item.state === "done" ? "✓" : item.state === "blocked" ? "⛔" : "○"}
                              </span>
                              <span className="db-cl-label">{item.label}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            <Section title="Geography">
              <div className="db-geo">
                <div className="db-geo-leg">
                  <div className="db-geo-label">SHIPPER</div>
                  <div className="db-geo-name">{detail.geography.shipper}</div>
                  <div className="db-geo-place">{detail.geography.pickupCityState}</div>
                  <div className="db-geo-window mono">{detail.geography.pickupWindow}</div>
                </div>
                <div className="db-geo-arrow">
                  <svg width="100%" height="14" viewBox="0 0 200 14" fill="none" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M0 7h195M188 2l7 5-7 5" stroke="var(--db-fg-faint)" strokeWidth="1" strokeLinecap="round" />
                  </svg>
                  <span className="db-geo-mi mono">{miles(detail.financials.loadedMi)} mi</span>
                </div>
                <div className="db-geo-leg">
                  <div className="db-geo-label">RECEIVER</div>
                  <div className="db-geo-name">{detail.geography.receiver}</div>
                  <div className="db-geo-place">{detail.geography.deliveryCityState}</div>
                  <div className="db-geo-window mono">{detail.geography.deliveryWindow}</div>
                </div>
              </div>
            </Section>

            <Section title="Financials">
              <div className="db-kv-grid two">
                <KV label="Line Haul" value={money(detail.financials.lineHaul)} mono strong />
                <KV label="Loaded Mi" value={miles(detail.financials.loadedMi)} mono />
                <KV label="PU DH" value={miles(detail.financials.puDh)} mono />
                <KV label="DEL DH" value={miles(detail.financials.delDh)} mono />
                <KV label="Total Mi" value={miles(detail.financials.totalMi)} mono />
                <KV label="Neg Mi" value={miles(detail.financials.negMi)} mono />
              </div>
              <div className="db-rpm-row">
                <div className="db-rpm">
                  <div className="db-rpm-label">Loaded RPM</div>
                  <div className="db-rpm-value mono">
                    {rpm(detail.financials.loadedRpm)}
                    <span className="db-rpm-suffix">/mi</span>
                  </div>
                </div>
                <div className="db-rpm strong">
                  <div className="db-rpm-label">Net Backhaul Yield</div>
                  <div className="db-rpm-value mono accent">
                    {rpm(detail.financials.nby)}
                    <span className="db-rpm-suffix">/mi</span>
                  </div>
                </div>
                <div className="db-rpm">
                  <div className="db-rpm-label">Empty %</div>
                  <div className="db-rpm-value mono">{pct(detail.financials.emptyPct, { fromRatio: true })}</div>
                </div>
              </div>
              {(detail.financials.puDh ?? 0) + (detail.financials.delDh ?? 0) > 80 ? (
                <p className="db-upload-error" style={{ marginTop: 10 }}>
                  DH alert: empty miles exceed 80. Confirm deadhead decision and exception note.
                </p>
              ) : null}
            </Section>

            {editing ? null : (
              <Section title="Operations">
                <div className="db-kv-grid two">
                  <KV label="Broker / Rep" value={detail.operations.brokerName} />
                  <KV label="MG Status" value={detail.operations.mgStatus} />
                  <KV label="TMW Status" value={detail.operations.tmwStatus} />
                  <KV label="PU Driver" value={detail.operations.pickupDriverAssigned} mono />
                  <KV label="Tractor / Trailer" value={detail.operations.tractorTrailer} mono />
                  <KV label="Commodity" value={detail.operations.commodity} />
                  <KV label="Equipment" value={detail.operations.equipmentNeeds} />
                  <KV label="Drop Lot" value={detail.section} />
                  <KV label="Driver Type" value={detail.operations.driverType} />
                  <KV label="POD" value={detail.operations.podStatus} />
                  <KV label="MG Task" value={detail.operations.mgStatusTask} />
                  <KV label="TMW Task" value={detail.operations.tmwStatusTask} />
                  <KV label="Scale Before" value={detail.operations.scaleBeforeTask} />
                  <KV label="Scale After" value={detail.operations.scaleAfterTask} />
                </div>
                {detail.operations.attentionNote !== "—" ? (
                  <p style={{ marginTop: 10 }}>
                    <span className="db-kv-k">Attention · {detail.operations.attentionSeverity}</span>
                    <br />
                    {detail.operations.attentionNote}
                  </p>
                ) : null}
                {detail.operations.coordinatorNotes !== "—" ? (
                  <p style={{ marginTop: 10 }}>
                    <span className="db-kv-k">Coordinator notes</span>
                    <br />
                    {detail.operations.coordinatorNotes}
                  </p>
                ) : null}
              </Section>
            )}
            {editing ? (
            <Section title="Legs">
              <div className="db-drawer-form-grid">
                <label className="db-field-label">
                  Leg Index
                  <input
                    className="db-input"
                    inputMode="numeric"
                    value={legForm.legIndex}
                    onChange={(e) => setLegForm((s) => ({ ...s, legIndex: e.target.value }))}
                  />
                </label>
                <label className="db-field-label">
                  Leg Type
                  <select className="db-input" value={legForm.legType} onChange={(e) => setLegForm((s) => ({ ...s, legType: e.target.value }))}>
                    <option value="SHUTTLE">SHUTTLE</option>
                    <option value="PTP">PTP</option>
                    <option value="DELIVERY">DELIVERY</option>
                  </select>
                </label>
                <label className="db-field-label">
                  Driver
                  <input className="db-input" value={legForm.driverName} onChange={(e) => setLegForm((s) => ({ ...s, driverName: e.target.value }))} />
                </label>
                <label className="db-field-label">
                  Trailer #
                  <input className="db-input" value={legForm.trailer} onChange={(e) => setLegForm((s) => ({ ...s, trailer: e.target.value }))} />
                </label>
                <label className="db-field-label db-field-check">
                  <input
                    type="checkbox"
                    checked={legForm.trailerHookConfirmed}
                    onChange={(e) => setLegForm((s) => ({ ...s, trailerHookConfirmed: e.target.checked }))}
                  />
                  Correct trailer hooked
                </label>
                <label className="db-field-label">
                  Leg Miles
                  <input className="db-input" value={legForm.legMiles} onChange={(e) => setLegForm((s) => ({ ...s, legMiles: e.target.value }))} />
                </label>
                <label className="db-field-label">
                  Start City
                  <input className="db-input" value={legForm.startCity} onChange={(e) => setLegForm((s) => ({ ...s, startCity: e.target.value }))} />
                </label>
                <label className="db-field-label">
                  Start ST
                  <input className="db-input" value={legForm.startState} onChange={(e) => setLegForm((s) => ({ ...s, startState: e.target.value }))} />
                </label>
                <label className="db-field-label">
                  End City
                  <input className="db-input" value={legForm.endCity} onChange={(e) => setLegForm((s) => ({ ...s, endCity: e.target.value }))} />
                </label>
                <label className="db-field-label">
                  End ST
                  <input className="db-input" value={legForm.endState} onChange={(e) => setLegForm((s) => ({ ...s, endState: e.target.value }))} />
                </label>
                <label className="db-field-label">
                  Leg ETA
                  <input
                    className="db-input"
                    type="datetime-local"
                    value={legForm.etaAt}
                    onChange={(e) => setLegForm((s) => ({ ...s, etaAt: e.target.value }))}
                  />
                </label>
                <label className="db-field-label">
                  On-site / Arrival
                  <input
                    className="db-input"
                    type="datetime-local"
                    value={legForm.arrivalAt}
                    onChange={(e) => setLegForm((s) => ({ ...s, arrivalAt: e.target.value }))}
                  />
                </label>
                <label className="db-field-label db-drawer-form-full">
                  Leg Notes / Handoff Note
                  <textarea className="db-input" rows={2} value={legForm.notes} onChange={(e) => setLegForm((s) => ({ ...s, notes: e.target.value }))} />
                </label>
              </div>
              <div className="db-row-with-actions db-drawer-actions-row">
                <button className="db-btn db-btn-mini" type="button" disabled={saving} onClick={() => void saveLeg()}>
                  {legForm.id ? "Update leg" : "Add leg"}
                </button>
                {legForm.id ? (
                  <button className="db-btn db-btn-mini db-btn-ghost" type="button" disabled={saving} onClick={resetLegForm}>
                    Cancel edit
                  </button>
                ) : null}
              </div>
              {detail.legs.length === 0 ? <p>No legs recorded.</p> : null}
              {detail.legs.map((leg) => (
                <div key={leg.id} className="db-drawer-leg-row">
                  <p>
                    #{leg.legIndex} {leg.legType} - {leg.start} {"->"} {leg.end} ({miles(leg.legMiles)}) [{leg.driverName}]
                    {leg.trailer !== "—" ? ` · trailer ${leg.trailer}${leg.trailerHookConfirmed ? " ✓" : ""}` : ""}
                    {leg.etaAtIso ? ` · ETA ${isoToLocalDisplay(leg.etaAtIso)}` : ""}
                    {leg.arrivalAtIso ? ` · arr ${isoToLocalDisplay(leg.arrivalAtIso)}` : ""}
                  </p>
                  <div className="db-row-with-actions">
                    <button className="db-btn db-btn-mini db-btn-ghost" type="button" disabled={saving} onClick={() => editLeg(leg)}>
                      Edit
                    </button>
                    <button className="db-btn db-btn-mini db-btn-ghost" type="button" disabled={saving} onClick={() => void removeLeg(leg.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </Section>
            ) : detail.legs.length > 0 ? (
            <Section title="Legs">
              {detail.legs.map((leg) => (
                <div key={leg.id} className="db-drawer-leg-row">
                  <p className="mono" style={{ margin: 0, fontSize: 12 }}>
                    #{leg.legIndex} {leg.legType} · {leg.start} → {leg.end} ({miles(leg.legMiles)} mi) · {leg.driverName}
                    {leg.trailer !== "—" ? ` · trailer ${leg.trailer}${leg.trailerHookConfirmed ? " ✓" : ""}` : ""}
                    {leg.etaAtIso ? ` · ETA ${isoToLocalDisplay(leg.etaAtIso)}` : ""}
                    {leg.arrivalAtIso ? ` · arr ${isoToLocalDisplay(leg.arrivalAtIso)}` : ""}
                  </p>
                </div>
              ))}
            </Section>
            ) : null}
            <Section title="Rate confirmation">
              {detail.rateConfirmation ? (
                <>
                  <a
                    className="db-ratecon-link"
                    href={detail.rateConfirmation.sourceFileUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <div className="db-ratecon-thumb">
                      <RateconDocIcon />
                    </div>
                    <div className="db-ratecon-meta">
                      <div className="db-ratecon-name mono">{detail.rateConfirmation.fileName}</div>
                      <div className="db-ratecon-sub dim">
                        {detail.rateConfirmation.parseConfidence === null
                          ? detail.rateConfirmation.parseState
                          : `${detail.rateConfirmation.parseState} · parsed ${pct(detail.rateConfirmation.parseConfidence, {
                              fromRatio: true
                            })} confidence`}
                      </div>
                    </div>
                    <span className="db-ratecon-cta">Open ↗</span>
                  </a>
                  <button
                    type="button"
                    className="db-btn db-btn-mini db-btn-ghost"
                    style={{ marginTop: 8 }}
                    onClick={() => setRcPreviewOpen((value) => !value)}
                    aria-expanded={rcPreviewOpen}
                  >
                    {rcPreviewOpen ? "Hide preview" : "Show preview"}
                  </button>
                  {rcPreviewOpen ? (
                    <iframe
                      src={detail.rateConfirmation.sourceFileUrl}
                      title={`Rate confirmation ${detail.rateConfirmation.id}`}
                      style={{ width: "100%", height: 360, border: "1px solid var(--db-border-soft)", marginTop: 8 }}
                    />
                  ) : null}
                </>
              ) : (
                <p className="dim">No rate confirmation attached.</p>
              )}
            </Section>

            <footer className="db-drawer-audit">
              <div className="db-audit-row">
                <span className="dim">Created by</span>
                <span>{detail.audit.createdByName}</span>
                <span className="mono dim">
                  {detail.audit.createdAt.slice(0, 10)} · {detail.audit.createdAt.slice(11, 16)}
                </span>
              </div>
              <div className="db-audit-row">
                <span className="dim">Last updated</span>
                <span>
                  {detail.audit.lastUpdatedByName !== "—"
                    ? `${detail.audit.lastUpdatedByName} · ${detail.audit.lastUpdatedAction}`
                    : "—"}
                </span>
                <span className="mono dim">
                  {detail.audit.updatedAt.slice(0, 10)} · {detail.audit.updatedAt.slice(11, 16)}
                </span>
              </div>
            </footer>
          </div>
        ) : null}
      </aside>
    </>
  );
}
