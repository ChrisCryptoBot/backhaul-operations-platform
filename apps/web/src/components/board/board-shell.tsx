"use client";

import React from "react";
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MoonIcon,
  SearchIcon,
  SunIcon
} from "@/components/icons";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { useTheme, AccentToggle } from "@/components/shell/theme";
import { int, money, pct, rpm } from "@/lib/ui/formatters";
import { mapBoardResponseToView, type ViewBoardResponse } from "@/lib/ui/board-mappers";
import { collectBoardAlertRollups, type LoadAlertRollup } from "@/lib/ui/load-alerts";
import { useAlertNotifier } from "@/lib/ui/use-alert-notifier";
import { TopbarSignOutButton } from "@/components/auth/sign-out-button";
import { StatusPill } from "./status-pill";
import { LoadDetailDrawer } from "./load-detail-drawer";
import { AttentionRail } from "./attention-rail";
import { CopilotPanel } from "@/components/copilot/copilot-panel";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";

interface BoardShellProps {
  board: ViewBoardResponse;
  boardError?: string | null;
  initialHighlightLoadId?: string | null;
  viewerIsAdmin?: boolean;
  viewerCanManageReference?: boolean;
}

const BOARD_COLUMN_COUNT = 32;

/** Empty% cell color class from the region's configurable thresholds (whole percents). */
function emptyPctClass(emptyPct: number | null, config: { emptyPctAmber: number; emptyPctRed: number }): string {
  if (emptyPct === null) return "";
  const pctValue = emptyPct * 100;
  if (pctValue >= config.emptyPctRed) return "empty-over";
  if (pctValue >= config.emptyPctAmber) return "empty-warn";
  return "";
}

/** Row background tint from the load's derived top alert severity (WARN/URGENT only). */
function rowAlertTintClass(rollup: LoadAlertRollup | undefined): string {
  if (!rollup) return "";
  if (rollup.topSeverity === "URGENT") return "db-row--urgent";
  if (rollup.topSeverity === "WARN") return "db-row--warn";
  return "";
}

/** Small per-row "needs attention" marker: a severity dot + count, with a tooltip listing items. */
function RowAlertMarker({ rollup }: { rollup: LoadAlertRollup | undefined }) {
  if (!rollup || !rollup.topSeverity) return null;
  const sev = rollup.topSeverity.toLowerCase();
  const title = rollup.alerts.map((alert) => `• ${alert.label}`).join("\n");
  return (
    <span
      className="db-alert-marker"
      title={title}
      role="img"
      aria-label={`${rollup.count} item${rollup.count > 1 ? "s" : ""} need attention`}
    >
      <span className={`db-flag-dot ${sev}${rollup.hasObligation ? " obligation" : ""}`} aria-hidden="true" />
      {rollup.count > 1 ? <sup className="db-flag-count">{rollup.count}</sup> : null}
    </span>
  );
}

/** Bell glyph for the desktop-alerts toggle (struck through when off). */
function BellIcon({ size = 16, muted = false }: { size?: number; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {muted ? <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
    </svg>
  );
}

/** Instant-read health tint for the NBY ($/mi) cell, mapping the design's RPM bands onto NBY. */
function nbyToneClass(nby: number | null): string {
  if (nby == null || !Number.isFinite(nby) || nby === 0) return "";
  if (nby >= 3) return "rpm-strong";
  if (nby < 1.5) return "rpm-below";
  if (nby < 2.2) return "rpm-thin";
  return "";
}

function splitCityState(value: string | null): { city: string; state: string } {
  if (!value) {
    return { city: "—", state: "" };
  }
  const [cityPart, statePart] = value.split(",").map((part) => part.trim());
  return { city: cityPart || "—", state: statePart || "" };
}

function formatBoardDate(dateIso: string): string {
  const parsed = new Date(`${dateIso}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return dateIso;
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(parsed);
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "2-digit", day: "2-digit" }).format(parsed);
}

function sectionCode(sectionId: string, title: string): string {
  const cleaned = sectionId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (cleaned.length >= 4) {
    return cleaned.slice(0, 6);
  }
  return title.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 6) || "LOT";
}

export function BoardShell({ board, boardError = null, initialHighlightLoadId = null, viewerIsAdmin = false, viewerCanManageReference = false }: BoardShellProps) {
  const [boardState, setBoardState] = React.useState(board);
  // Client-only clock for time-based alerts (firm-appt escalation). Stays undefined
  // during SSR/first paint so server and client markup match, then ticks each minute.
  const [alertNowMs, setAlertNowMs] = React.useState<number | undefined>(undefined);
  React.useEffect(() => {
    setAlertNowMs(Date.now());
    const id = window.setInterval(() => setAlertNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // One derivation of "needs attention" per board, fed to the row markers and the rail.
  const alertRollupList = React.useMemo(
    () =>
      collectBoardAlertRollups(boardState, {
        emptyPctAmber: boardState.config.emptyPctAmber,
        emptyPctRed: boardState.config.emptyPctRed,
        now: alertNowMs
      }),
    [boardState, alertNowMs]
  );
  const alertRollupById = React.useMemo(() => {
    const map = new Map<string, LoadAlertRollup>();
    for (const rollup of alertRollupList) map.set(rollup.loadId, rollup);
    return map;
  }, [alertRollupList]);
  const [attentionCollapsed, setAttentionCollapsed] = React.useState(false);
  const [selectedLoadId, setSelectedLoadId] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const { theme: themeMode, toggleTheme: toggleThemeMode } = useTheme();
  const [density, setDensity] = React.useState<"comfortable" | "compact">("comfortable");
  const [dragOverSectionId, setDragOverSectionId] = React.useState<string | null>(null);
  const [highlightLoadId, setHighlightLoadId] = React.useState<string | null>(initialHighlightLoadId);
  const [contextMenu, setContextMenu] = React.useState<{ loadId: string; x: number; y: number } | null>(null);
  type DialogState =
    | null
    | { kind: "tonu"; loadId: string; isTonu: boolean }
    | { kind: "delete"; loadId: string };
  const [dialogState, setDialogState] = React.useState<DialogState>(null);
  const [dialogSubmitting, setDialogSubmitting] = React.useState(false);
  const [tonuAmountInput, setTonuAmountInput] = React.useState("150.00");
  const [deleteReasonInput, setDeleteReasonInput] = React.useState("");
  const boardDateInputRef = React.useRef<HTMLInputElement | null>(null);
  const sectionRefs = React.useRef(new Map<string, HTMLTableRowElement>());

  React.useEffect(() => {
    setBoardState(board);
  }, [board]);

  React.useEffect(() => {
    const saved = window.localStorage.getItem("db-density");
    if (saved === "compact" || saved === "comfortable") {
      setDensity(saved);
    }
  }, []);

  const setDensityMode = React.useCallback((next: "comfortable" | "compact") => {
    setDensity(next);
    try {
      window.localStorage.setItem("db-density", next);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const allSectionsEmpty = React.useMemo(
    () => boardState.sections.every((section) => section.loads.length === 0),
    [boardState.sections]
  );

  const mutateBoard = React.useCallback(
    async (payload: Record<string, unknown>) => {
      const response = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          date: boardState.date,
          regionId: boardState.regionId
        })
      });
      const apiPayload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(apiPayload?.error ?? "Board update failed.");
      }
      try {
        setBoardState(mapBoardResponseToView(apiPayload as never));
      } catch {
        const reloadResponse = await fetch(
          `/api/board?date=${encodeURIComponent(boardState.date)}&regionId=${encodeURIComponent(boardState.regionId)}`,
          {
          cache: "no-store"
          }
        );
        const reloadPayload = (await reloadResponse.json().catch(() => null)) as { error?: string } | null;
        if (!reloadResponse.ok) {
          throw new Error(reloadPayload?.error ?? "Board refresh failed after mutation.");
        }
        setBoardState(mapBoardResponseToView(reloadPayload as never));
      }
    },
    [boardState.date, boardState.regionId]
  );

  const reloadBoard = React.useCallback(async () => {
    try {
      const response = await fetch(
        `/api/board?date=${encodeURIComponent(boardState.date)}&regionId=${encodeURIComponent(boardState.regionId)}`,
        { cache: "no-store" }
      );
      if (!response.ok) return;
      const payload = await response.json();
      setBoardState(mapBoardResponseToView(payload as never));
    } catch {
      /* best-effort refresh */
    }
  }, [boardState.date, boardState.regionId]);

  const alertNotifier = useAlertNotifier({
    rollups: alertRollupList,
    refreshBoard: reloadBoard,
    onOpenLoad: (loadId) => setSelectedLoadId(loadId)
  });

  const moveLoadToSection = React.useCallback(
    async (loadId: string, targetSectionId: string) => {
      try {
        await mutateBoard({
          action: "move",
          loadId,
          targetSectionId
        });
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "Board update failed.");
      }
    },
    [mutateBoard]
  );

  const toggleTonuLifecycle = React.useCallback(
    (loadId: string, isTonu: boolean) => {
      if (!isTonu) {
        void mutateBoard({ action: "tonu", loadId, isTonu }).catch((error) => {
          setUploadError(error instanceof Error ? error.message : "TONU update failed.");
        });
        return;
      }
      setTonuAmountInput("150.00");
      setDialogSubmitting(false);
      setDialogState({ kind: "tonu", loadId, isTonu: true });
    },
    [mutateBoard]
  );

  const confirmTonu = React.useCallback(async () => {
    if (dialogState?.kind !== "tonu") return;
    const { loadId, isTonu } = dialogState;
    const amount = tonuAmountInput.trim();
    if (!amount) {
      setUploadError("TONU amount is required.");
      return;
    }
    if (dialogSubmitting) {
      return;
    }
    setDialogSubmitting(true);
    setUploadError(null);
    try {
      await mutateBoard({ action: "tonu", loadId, isTonu, tonuAmount: amount });
      setDialogState(null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "TONU update failed.");
    } finally {
      setDialogSubmitting(false);
    }
  }, [dialogState, dialogSubmitting, mutateBoard, tonuAmountInput]);

  const setLoadStatus = React.useCallback(
    async (loadId: string, status: "BOOKED" | "CANCELED" | "FAILED") => {
      try {
        await mutateBoard({ action: "status", loadId, status });
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "Status update failed.");
      }
    },
    [mutateBoard]
  );

  const updateLoadFields = React.useCallback(
    async (loadId: string, fields: Record<string, unknown>) => {
      try {
        await mutateBoard({ action: "update-fields", loadId, fields });
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "Field update failed.");
      }
    },
    [mutateBoard]
  );

  const setLoadStatusFromDrawer = React.useCallback(
    async (
      loadId: string,
      status: "BOOKED" | "DISPATCHED" | "PICKED_UP" | "DELIVERED" | "POD_RECEIVED" | "COMPLETED" | "CANCELED" | "FAILED",
      overrideReason?: string
    ) => {
      // Dedicated fetch (not mutateBoard) so the soft-gate 409 (needsOverrideReason +
      // openItems) reaches the drawer, which prompts for a reason and retries.
      const response = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", loadId, status, overrideReason, date: boardState.date, regionId: boardState.regionId })
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; needsOverrideReason?: boolean; openItems?: string[] }
        | null;
      if (!response.ok) {
        if (payload?.needsOverrideReason) {
          throw Object.assign(new Error(payload.error ?? "Open items remain."), {
            needsOverrideReason: true,
            openItems: payload.openItems ?? []
          });
        }
        const message = payload?.error ?? "Status update failed.";
        setUploadError(message);
        throw new Error(message);
      }
      setBoardState(mapBoardResponseToView(payload as never));
    },
    [boardState.date, boardState.regionId]
  );

  const updateLoadFieldsFromDrawer = React.useCallback(
    async (loadId: string, fields: Record<string, unknown>) => {
      try {
        await mutateBoard({ action: "update-fields", loadId, fields });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Field update failed.";
        setUploadError(message);
        throw new Error(message);
      }
    },
    [mutateBoard]
  );

  const softDeleteLoad = React.useCallback(
    (loadId: string) => {
      setDeleteReasonInput("");
      setDialogSubmitting(false);
      setDialogState({ kind: "delete", loadId });
    },
    []
  );

  const confirmDelete = React.useCallback(async () => {
    if (dialogState?.kind !== "delete") return;
    const { loadId } = dialogState;
    const reason = deleteReasonInput.trim();
    if (reason.length < 10) {
      setUploadError("Delete reason must be at least 10 characters.");
      return;
    }
    if (dialogSubmitting) {
      return;
    }
    setDialogSubmitting(true);
    setUploadError(null);
    try {
      await mutateBoard({ action: "delete", loadId, reason });
      setDialogState(null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Delete failed.");
    } finally {
      setDialogSubmitting(false);
    }
  }, [deleteReasonInput, dialogState, dialogSubmitting, mutateBoard]);

  const upsertLegFromDrawer = React.useCallback(
    async (loadId: string, leg: Record<string, unknown>) => {
      try {
        await mutateBoard({ action: "leg-upsert", loadId, leg });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Leg update failed.";
        setUploadError(message);
        throw new Error(message);
      }
    },
    [mutateBoard]
  );

  const deleteLegFromDrawer = React.useCallback(
    async (loadId: string, legId: string) => {
      try {
        await mutateBoard({ action: "leg-delete", loadId, legId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Leg delete failed.";
        setUploadError(message);
        throw new Error(message);
      }
    },
    [mutateBoard]
  );

  const rescheduleDeliveryFromDrawer = React.useCallback(
    async (
      loadId: string,
      appt: { newDate: string; windowStart: string; windowEnd: string; apptType: "FIRM_APPT" | "OPEN_WINDOW" | "FCFS" }
    ) => {
      try {
        await mutateBoard({ action: "reschedule-delivery", loadId, ...appt });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Reschedule failed.";
        setUploadError(message);
        throw new Error(message);
      }
    },
    [mutateBoard]
  );

  const selectedLoad = React.useMemo(
    () => boardState.sections.flatMap((section) => section.loads).find((load) => load.id === selectedLoadId) ?? null,
    [boardState.sections, selectedLoadId]
  );

  const handleDateChange = React.useCallback((nextDate: string) => {
    if (!nextDate || nextDate === boardState.date) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set("date", nextDate);
    params.set("regionId", boardState.regionId);
    window.location.assign(`/?${params.toString()}`);
  }, [boardState.date, boardState.regionId]);

  const openBoardDatePicker = React.useCallback(() => {
    const input = boardDateInputRef.current as (HTMLInputElement & { showPicker?: () => void }) | null;
    if (!input) {
      return;
    }
    if (typeof input.showPicker === "function") {
      input.showPicker();
      return;
    }
    input.focus();
    input.click();
  }, []);

  const handleRegionChange = React.useCallback((nextRegionId: string) => {
    if (!nextRegionId) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set("regionId", nextRegionId);
    params.set("date", boardState.date);
    window.location.assign(`/?${params.toString()}`);
  }, [boardState.date]);

  const boardDateLabel = formatBoardDate(boardState.date);
  const regionLabel = boardState.regionLabel ?? "NORTHEAST";
  const regionCode = boardState.regionCode ?? sectionCode(boardState.regionId, boardState.regionId);

  const filteredSections = React.useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return boardState.sections;
    }
    return boardState.sections.map((section) => {
      const loads = section.loads.filter((load) => {
        const haystack = [
          load.ref,
          load.brokerName,
          load.brokerRepName,
          load.shipper,
          load.receiver,
          load.pickupCityState,
          load.deliveryCityState,
          load.commodity,
          load.pickupDriverAssigned,
          load.pickupNumber,
          ...(load.pickupNumbers ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });
      return { ...section, loads };
    });
  }, [boardState.sections, searchQuery]);

  React.useEffect(() => {
    if (!highlightLoadId) return;
    setSelectedLoadId(highlightLoadId);
    const timer = window.setTimeout(() => setHighlightLoadId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [highlightLoadId]);

  return (
    <div className="db-root db-app db-board" data-theme={themeMode} data-density={density}>
      <AppSidebar
        viewerIsAdmin={viewerIsAdmin}
        viewerCanManageReference={viewerCanManageReference}
        regionCode={regionCode}
        regionLabel={regionLabel}
      />

      <div className="db-shell">
        <header className="db-header">
          <div className="db-h-context">
            <div className="db-tb-search">
              <SearchIcon size={14} />
              <input
                type="search"
                className="db-input"
                placeholder="Search ref, broker, city…"
                aria-label="Search loads"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="db-h-spacer" />
        <div className="db-topbar-right">
          {boardState.availableRegions.length > 1 ? (
            <select
              className="db-datepicker"
              value={boardState.activeRegionId ?? boardState.regionId}
              onChange={(event) => handleRegionChange(event.target.value)}
              aria-label="Board region"
            >
              {boardState.availableRegions.map((region) => (
                <option key={region.id} value={region.id}>
                  {region.code}
                </option>
              ))}
            </select>
          ) : null}
          <label
            className="db-datepicker"
            onClick={(event) => {
              event.preventDefault();
              openBoardDatePicker();
            }}
          >
            <CalendarIcon size={14} />
            <span className="mono">{boardDateLabel}</span>
            <ChevronDownIcon size={12} />
            <input
              ref={boardDateInputRef}
              aria-label="Board date"
              type="date"
              className="db-date-input"
              value={boardState.date}
              onChange={(event) => handleDateChange(event.target.value)}
            />
          </label>
          <AccentToggle />
          <button
            type="button"
            className="db-iconbtn"
            onClick={toggleThemeMode}
            title={themeMode === "dark" ? "Light theme" : "Dark theme"}
            aria-label={`Switch to ${themeMode === "light" ? "dark" : "light"} mode`}
          >
            {themeMode === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
          <button
            type="button"
            className={`db-iconbtn db-alert-bell${alertNotifier.enabled ? " on" : ""}`}
            onClick={() => void alertNotifier.toggle()}
            disabled={alertNotifier.permission === "unsupported"}
            aria-pressed={alertNotifier.enabled}
            title={
              alertNotifier.permission === "unsupported"
                ? "Desktop notifications not supported in this browser"
                : alertNotifier.enabled
                  ? "Desktop alerts on — notifications + chime for urgent loads"
                  : "Enable desktop alerts for urgent loads"
            }
            aria-label={alertNotifier.enabled ? "Disable desktop alerts" : "Enable desktop alerts"}
          >
            <BellIcon size={16} muted={!alertNotifier.enabled} />
          </button>
          <TopbarSignOutButton />
        </div>
      </header>

      <div className="db-layout db-body">
        <main className="db-main">
          <div className="db-main-head">
            <div className="db-breadcrumb">
              <span className="dim">Daily Load Tracker</span>
              <ChevronRightIcon size={12} />
              <span>{boardDateLabel}</span>
            </div>
            <div className="db-day-totals">
              <div className="db-stat">
                <span className="db-stat-label">Loads</span>
                <span className="db-stat-value mono">{int(boardState.totals.loads)}</span>
              </div>
              <div className="db-stat-sep" />
              <div className="db-stat">
                <span className="db-stat-label">Line Haul</span>
                <span className="db-stat-value mono">{money(boardState.totals.lineHaul, { decimals: 0 })}</span>
              </div>
              <div className="db-stat-sep" />
              <div className="db-stat">
                <span className="db-stat-label">NBY</span>
                <span className="db-stat-value mono">{rpm(boardState.totals.nby)}</span>
              </div>
              <div className="db-stat-sep" />
              <div className="db-stat">
                <span className="db-stat-label">Loaded Mi</span>
                <span className="db-stat-value mono">{int(boardState.totals.loadedMiles)}</span>
              </div>
              <div className="db-stat-sep" />
              <div className="db-stat">
                <span className="db-stat-label">Empty %</span>
                <span className="db-stat-value mono">{pct(boardState.totals.emptyPctRatio, { fromRatio: true })}</span>
              </div>
              <div className="db-stat-sep" />
              <div className="db-stat">
                <span className="db-stat-label">TONU</span>
                <span className="db-stat-value mono">{money(boardState.totals.tonu, { decimals: 0 })}</span>
              </div>
            </div>
          </div>

          <div className="db-board-toolbar">
            <div className="db-seg" role="group" aria-label="Row density">
              <button
                type="button"
                className={density === "comfortable" ? "active" : ""}
                aria-pressed={density === "comfortable"}
                onClick={() => setDensityMode("comfortable")}
              >
                Comfortable
              </button>
              <button
                type="button"
                className={density === "compact" ? "active" : ""}
                aria-pressed={density === "compact"}
                onClick={() => setDensityMode("compact")}
              >
                Compact
              </button>
            </div>
            {filteredSections.length > 0 ? (
              <div className="db-tb-lots" aria-label="Jump to drop lot">
                {filteredSections.map((section) => (
                  <a
                    key={section.id}
                    href={`#sec-${section.id}`}
                    className={`db-tb-lot${section.capacity != null && section.filledCount > section.capacity ? " over" : ""}`}
                    title={`Jump to ${section.title}`}
                  >
                    {section.code ?? sectionCode(section.id, section.title)}
                    <span className="n">{section.filledCount}{section.capacity != null ? `/${section.capacity}` : ""}</span>
                  </a>
                ))}
              </div>
            ) : null}
          </div>

          {boardError ? <p className="db-msg">{boardError}</p> : null}
          {uploadError ? <p className="db-upload-error" role="status" aria-live="polite">{uploadError}</p> : null}
          {allSectionsEmpty ? (
            <EmptyState
              inline
              title={`No loads booked for ${boardState.date}`}
              copy="Use the copilot to drop a rate con and start an intake."
            />
          ) : null}


          <div className="db-table-wrap">
            <table className="db-table grouped">
              <caption className="db-sr-only">Daily load board sections and loads</caption>
              <thead>
                <tr className="db-colgroup-row">
                  <th colSpan={9} className="g-primary">Load</th>
                  <th colSpan={4} className="grp-start">Driver &amp; Equip</th>
                  <th colSpan={3} className="grp-start">Pickup</th>
                  <th colSpan={4} className="grp-start">Delivery</th>
                  <th colSpan={3} className="grp-start g-financial right">Financial</th>
                  <th colSpan={9} className="grp-start right">Miles &amp; RPM</th>
                </tr>
                <tr className="db-collabel-row">
                  <th className="stick stick-ref">REF#</th>
                  <th className="stick stick-status stick-last">STATUS</th>
                  <th>NOTE</th>
                  <th>SCALE BEF</th>
                  <th>SCALE AFT</th>
                  <th>PU#(s)</th>
                  <th>Broker (rep)</th>
                  <th>MG</th>
                  <th>TMW</th>
                  <th>PU Driver</th>
                  <th>Trk/Trlr</th>
                  <th>Commodity</th>
                  <th>Equip</th>
                  <th>Shipper</th>
                  <th>PU City, ST</th>
                  <th>PU Window</th>
                  <th>Receiver</th>
                  <th>DEL City, ST</th>
                  <th>DEL Date/Win</th>
                  <th>POD</th>
                  <th className="right">Line Haul</th>
                  <th className="right">TONU Amt</th>
                  <th className="right">All-In Rev</th>
                  <th className="right">Ldd Mi</th>
                  <th className="right">PU DH</th>
                  <th className="right">DEL DH</th>
                  <th className="right">Total Mi</th>
                  <th className="right">Neg Mi</th>
                  <th className="right">Ldd RPM</th>
                  <th className="right">NBY</th>
                  <th className="right">Empty %</th>
                  <th className="right">Del</th>
                </tr>
              </thead>
              <tbody>
                {filteredSections.map((section) => (
                  <React.Fragment key={section.id}>
                    <tr
                      className={`db-section-row ${dragOverSectionId === section.id ? "selected" : ""}`}
                      id={`sec-${section.id}`}
                      ref={(element) => { if (element) sectionRefs.current.set(section.id, element); }}
                      onDragOver={(event) => {
                        if (section.type === "deliveries") return;
                        event.preventDefault();
                        setDragOverSectionId(section.id);
                      }}
                      onDragLeave={() => {
                        setDragOverSectionId((current) => (current === section.id ? null : current));
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (section.type === "deliveries") return;
                        const loadId = event.dataTransfer.getData("text/plain");
                        setDragOverSectionId(null);
                        if (loadId) {
                          void moveLoadToSection(loadId, section.id);
                        }
                      }}
                    >
                      <td colSpan={BOARD_COLUMN_COUNT} className="db-section-cell">
                        <div className="db-section-inner">
                          <span className="db-section-code mono">{section.code ?? sectionCode(section.id, section.title)}</span>
                          <span className="db-section-name">{section.title}</span>
                          {section.city && section.state && !section.title.toLowerCase().includes(section.city.toLowerCase()) ? <span className="db-section-city">{section.city}, {section.state}</span> : null}
                          <span
                            className={`db-cap mono${section.capacity != null && section.filledCount > section.capacity ? " over" : section.capacity != null && section.filledCount === section.capacity ? " full" : ""}`}
                            title={section.capacity != null ? `${section.filledCount} of ${section.capacity} capacity` : `${section.filledCount} loads`}
                            aria-label={section.capacity != null ? `${section.filledCount} of ${section.capacity} capacity in this lot` : `${section.filledCount} loads in this lane`}
                          >
                            {section.filledCount}{section.capacity != null ? `/${section.capacity}` : ""}
                          </span>
                          {section.note ? <span className="db-section-note">{section.note}</span> : null}
                        </div>
                      </td>
                    </tr>
                    {section.loads.length === 0 ? (
                      <tr className="db-empty-row">
                        <td colSpan={BOARD_COLUMN_COUNT} className="db-empty-cell"><span className="dim">{section.type === "deliveries" ? "No deliveries due on this day." : `No loads booked for ${section.title}.`}</span></td>
                      </tr>
                    ) : (
                      section.loads.map((load, loadIndex) => (
                        <React.Fragment key={load.id}>
                          <tr
                            draggable={section.type !== "deliveries"}
                            onDragStart={(event) => {
                              if (section.type === "deliveries") {
                                event.preventDefault();
                                return;
                              }
                              event.dataTransfer.setData("text/plain", load.id);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            className={`db-row ${loadIndex % 2 === 1 ? "odd" : ""} ${selectedLoadId === load.id || highlightLoadId === load.id ? "selected" : ""} ${rowAlertTintClass(alertRollupById.get(load.id))}`}
                            onClick={() => setSelectedLoadId(load.id)}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setContextMenu({ loadId: load.id, x: event.clientX, y: event.clientY });
                            }}
                          >
                            <td className="stick stick-ref">
                              <RowAlertMarker rollup={alertRollupById.get(load.id)} />
                              <button type="button" className="db-row-open-btn" aria-label={`Open details for ${load.ref}`} onClick={(event) => { event.stopPropagation(); setSelectedLoadId(load.id); }}>
                                {load.ref}
                              </button>
                            </td>
                            <td className="stick stick-status stick-last"><StatusPill status={load.status} /></td>
                            <td className="trunc" title={load.coordinatorNotes ?? load.lateCancelFailedNote ?? undefined}>
                              {load.coordinatorNotes ?? load.lateCancelFailedNote ?? "—"}
                            </td>
                            <td>
                              <select
                                className="db-datepicker"
                                aria-label={`Scale Before for ${load.ref}`}
                                value={load.scaleBeforeTask}
                                onChange={(event) => void updateLoadFields(load.id, { scaleBeforeTask: event.target.value })}
                              >
                                <option value="NOT_DONE">NOT_DONE</option>
                                <option value="DONE">DONE</option>
                              </select>
                            </td>
                            <td>
                              <select
                                className="db-datepicker"
                                aria-label={`Scale After for ${load.ref}`}
                                value={load.scaleAfterTask}
                                onChange={(event) => void updateLoadFields(load.id, { scaleAfterTask: event.target.value })}
                              >
                                <option value="NOT_DONE">NOT_DONE</option>
                                <option value="DONE">DONE</option>
                              </select>
                            </td>
                            <td className="mono">{(load.pickupNumbers ?? []).length > 0 ? (load.pickupNumbers ?? []).join(", ") : (load.pickupNumber ?? "—")}</td>
                            <td className="trunc" title={load.brokerName ?? undefined}>{load.brokerName ?? "—"}{load.brokerRepName ? ` (${load.brokerRepName})` : ""}</td>
                            <td>
                              <select
                                className="db-datepicker"
                                aria-label={`MG task for ${load.ref}`}
                                value={load.mgStatusTask}
                                onChange={(event) => void updateLoadFields(load.id, { mgStatusTask: event.target.value })}
                              >
                                <option value="NOT_DONE">NOT_DONE</option>
                                <option value="DONE">DONE</option>
                              </select>
                            </td>
                            <td>
                              <select
                                className="db-datepicker"
                                aria-label={`TMW task for ${load.ref}`}
                                value={load.tmwStatusTask}
                                onChange={(event) => void updateLoadFields(load.id, { tmwStatusTask: event.target.value })}
                              >
                                <option value="NOT_DONE">NOT_DONE</option>
                                <option value="DONE">DONE</option>
                              </select>
                            </td>
                            <td className="trunc" title={load.pickupDriverAssigned ?? undefined}>{load.pickupDriverAssigned ?? "—"}</td>
                            <td className="trunc">{[load.tractorTrailer1, load.tractorTrailer2].filter(Boolean).join(" / ") || "—"}</td>
                            <td className="trunc">{load.commodity ?? "—"}</td>
                            <td className="trunc">{load.equipmentType ?? load.equipmentNeeds ?? "—"}</td>
                            <td className="trunc" title={load.shipper}>{load.shipper}</td>
                            <td><span className="db-city">{splitCityState(load.pickupCityState).city}</span>{splitCityState(load.pickupCityState).state ? <span className="db-state mono">{splitCityState(load.pickupCityState).state}</span> : null}</td>
                            <td className="mono dim">{load.pickupWindow ?? "—"}</td>
                            <td className="trunc" title={load.receiver}>{load.receiver}</td>
                            <td><span className="db-city">{splitCityState(load.deliveryCityState).city}</span>{splitCityState(load.deliveryCityState).state ? <span className="db-state mono">{splitCityState(load.deliveryCityState).state}</span> : null}</td>
                            <td className="mono dim">
                              <input
                                type="date"
                                className="db-datepicker"
                                aria-label={`Delivery date for ${load.ref}`}
                                value={load.deliveryDate ? load.deliveryDate.slice(0, 10) : ""}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => void updateLoadFields(load.id, { deliveryDate: event.target.value || null })}
                              />
                              {" / "}{load.deliveryWindow ?? "—"}
                            </td>
                            <td className="mono">{load.podStatus ?? "—"}</td>
                            <td className="right mono num">{money(load.lineHaul)}</td>
                            <td className="right mono num">{money(load.tonuAmount)}</td>
                            <td className="right mono num">{money(load.allInRevenue)}</td>
                            <td className="right mono num">{int(load.loadedMi)}</td>
                            <td className="right mono num dim">{int(load.puDh)}</td>
                            <td className="right mono num dim">{int(load.delDh)}</td>
                            <td className="right mono num">{int(load.totalMi)}</td>
                            <td className="right mono num">{int(load.negMi)}</td>
                            <td className="right mono num">{rpm(load.loadedRpm)}</td>
                            <td className={`right mono num ${nbyToneClass(load.nby)}`}>{rpm(load.nby)}</td>
                            <td className={`right mono num ${emptyPctClass(load.emptyPct, boardState.config)}`}>{pct(load.emptyPct, { fromRatio: true })}</td>
                            <td className="right">
                              <button className="db-btn db-btn-mini db-btn-ghost" type="button" onClick={(event) => { event.stopPropagation(); void softDeleteLoad(load.id); }}>
                                X
                              </button>
                            </td>
                          </tr>
                        </React.Fragment>
                      ))
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {contextMenu ? (
            <div
              className="db-mgmt-notes"
              style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 40, maxWidth: 260 }}
              onMouseLeave={() => setContextMenu(null)}
            >
              <div className="db-mgmt-notes-h">Row actions</div>
              <div className="db-row-with-actions">
                <button className="db-btn db-btn-mini" onClick={() => { void setLoadStatus(contextMenu.loadId, "CANCELED"); setContextMenu(null); }}>Cancel</button>
                <button className="db-btn db-btn-mini" onClick={() => { void toggleTonuLifecycle(contextMenu.loadId, true); setContextMenu(null); }}>Mark TONU</button>
                <button className="db-btn db-btn-mini" onClick={() => { void setLoadStatus(contextMenu.loadId, "FAILED"); setContextMenu(null); }}>Mark failed</button>
              </div>
              <div className="db-row-with-actions">
                <button
                  className="db-btn db-btn-mini db-btn-ghost"
                  onClick={() => {
                    const load = boardState.sections.flatMap((section) => section.loads).find((item) => item.id === contextMenu.loadId);
                    if (load?.rateConfirmationId) {
                      window.location.assign(
                        `/review?rateConfirmationId=${encodeURIComponent(load.rateConfirmationId)}&regionId=${encodeURIComponent(boardState.regionId)}`
                      );
                    } else {
                      setSelectedLoadId(contextMenu.loadId);
                    }
                    setContextMenu(null);
                  }}
                >
                  View Rate Con
                </button>
                <button className="db-btn db-btn-mini db-btn-ghost" onClick={() => { setSelectedLoadId(contextMenu.loadId); setContextMenu(null); }}>Edit / View</button>
                <button className="db-btn db-btn-mini db-btn-ghost" onClick={() => setContextMenu(null)}>Close</button>
              </div>
            </div>
          ) : null}

        </main>

        <AttentionRail
          rollups={alertRollupList}
          selectedLoadId={selectedLoadId}
          onSelect={(loadId) => setSelectedLoadId(loadId)}
          collapsed={attentionCollapsed}
          onToggleCollapsed={() => setAttentionCollapsed((value) => !value)}
        />

        <CopilotPanel
          regionId={boardState.activeRegionId ?? boardState.regionId}
          date={boardState.date}
          onChanged={() => void reloadBoard()}
        />
      </div>

      <LoadDetailDrawer
        loadId={selectedLoadId}
        regionId={boardState.regionId}
        fallbackLoad={selectedLoad}
        onClose={() => setSelectedLoadId(null)}
        onSetStatus={setLoadStatusFromDrawer}
        onUpdateFields={updateLoadFieldsFromDrawer}
        onUpsertLeg={upsertLegFromDrawer}
        onDeleteLeg={deleteLegFromDrawer}
        onRescheduleDelivery={rescheduleDeliveryFromDrawer}
      />

      {dialogState?.kind === "tonu" ? (
        <Modal
          title="Mark TONU"
          busy={dialogSubmitting}
          onClose={() => setDialogState(null)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={dialogSubmitting} onClick={() => setDialogState(null)}>Cancel</button>
              <button type="button" className="db-btn" disabled={dialogSubmitting} aria-busy={dialogSubmitting} onClick={() => void confirmTonu()}>
                {dialogSubmitting ? "Saving..." : "Confirm TONU"}
              </button>
            </>
          }
        >
          <label className="db-field-label">TONU Amount ($)</label>
          <input
            type="number"
            className="db-input"
            min="0"
            step="0.01"
            value={tonuAmountInput}
            disabled={dialogSubmitting}
            onChange={(e) => setTonuAmountInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void confirmTonu();
            }}
          />
        </Modal>
      ) : null}

      {dialogState?.kind === "delete" ? (
        <Modal
          title="Delete Load"
          ariaLabel="Delete load"
          busy={dialogSubmitting}
          onClose={() => setDialogState(null)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={dialogSubmitting} onClick={() => setDialogState(null)}>Cancel</button>
              <button
                type="button"
                className="db-btn db-btn-danger"
                disabled={dialogSubmitting || deleteReasonInput.trim().length < 10}
                aria-busy={dialogSubmitting}
                onClick={() => void confirmDelete()}
              >
                {dialogSubmitting ? "Deleting..." : "Delete"}
              </button>
            </>
          }
        >
          <label className="db-field-label">Reason (min 10 chars)</label>
          <textarea
            className="db-input"
            rows={3}
            value={deleteReasonInput}
            disabled={dialogSubmitting}
            onChange={(e) => setDeleteReasonInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void confirmDelete();
              }
            }}
          />
        </Modal>
      ) : null}

      </div>
    </div>
  );
}
