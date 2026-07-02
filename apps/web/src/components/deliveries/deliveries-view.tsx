import React from "react";
import Link from "next/link";
import { StatusPill } from "@/components/board/status-pill";
import { resolveDriverLabel, type ViewBoardLoadRow } from "@/lib/ui/board-mappers";

/** Deep-link to the load on the tracker (its booking day) with the detail drawer open. */
function loadHref(row: ViewBoardLoadRow): string {
  const day = row.bookingDate ? row.bookingDate.slice(0, 10) : null;
  return day ? `/?date=${day}&load=${row.id}` : `/?load=${row.id}`;
}

interface DeliveriesViewProps {
  deliveries: ViewBoardLoadRow[];
  /** Today's date (board timezone), YYYY-MM-DD. */
  asOf: string;
}

type DeliveryFlag = "overdue" | "today" | "pod_due" | "upcoming" | "unscheduled";

const APPT_TYPE_LABELS: Record<string, string> = { FIRM_APPT: "FIRM", OPEN_WINDOW: "OPEN", FCFS: "FCFS" };
const PU_DEL_PRESET_LABELS: Record<string, string> = {
  ETA_TO_PU_DEL: "ETA TO PU/DEL",
  LOADED_SET_TO_DEL: "LOADED, SET TO DEL",
  LATE: "LATE",
  DONE: "DONE",
  OTHER: ""
};

function isoTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function apptCell(type: string | null, startIso: string | null, endIso: string | null): string {
  const label = type ? (APPT_TYPE_LABELS[type] ?? type) : null;
  const start = isoTime(startIso);
  const end = isoTime(endIso);
  const window = start && end ? `${start}–${end}` : (start ?? end);
  return (label && window ? `${label} ${window}` : label ?? window) ?? "—";
}

function statusLabel(preset: string, custom: string | null): string {
  const trimmed = custom?.trim();
  if (trimmed) return trimmed;
  return PU_DEL_PRESET_LABELS[preset] || "—";
}

function laneText(cityState: string | null): string {
  return cityState && cityState.trim() ? cityState : "—";
}

/** Delivery lifecycle bucket, relative to today, for sorting/flagging. */
function deliveryFlag(row: ViewBoardLoadRow, asOf: string): DeliveryFlag {
  if (row.status === "DELIVERED") return "pod_due";
  const due = row.deliveryDate ? row.deliveryDate.slice(0, 10) : null;
  if (!due) return "unscheduled";
  if (due < asOf) return "overdue";
  if (due === asOf) return "today";
  return "upcoming";
}

const FLAG_META: Record<DeliveryFlag, { label: string; cls: string }> = {
  overdue: { label: "Overdue", cls: "db-del-flag-overdue" },
  today: { label: "Due today", cls: "db-del-flag-today" },
  pod_due: { label: "POD due", cls: "db-del-flag-pod" },
  upcoming: { label: "Upcoming", cls: "db-del-flag-upcoming" },
  unscheduled: { label: "No date", cls: "db-del-flag-none" }
};

function DriverList({ row }: { row: ViewBoardLoadRow }) {
  const legs = row.legs ?? [];
  const drivers =
    legs.length > 0
      ? legs.map((leg) => resolveDriverLabel(leg.driverCode, leg.driverFullName, leg.driverName))
      : [resolveDriverLabel(row.pickupDriverCode, row.pickupDriverFullName, row.pickupDriverAssigned)];
  const labelled = drivers.filter((d) => d.label);
  if (labelled.length === 0) return <>—</>;
  return (
    <span className="db-driver-chain">
      {labelled.map((driver, index) => (
        <span key={index} className="db-driver-chain-seg">
          {index > 0 ? <span className="db-driver-arrow" aria-hidden="true">→</span> : null}
          {driver.rostered ? (
            <span className="db-driver-rostered" title={driver.fullName ? `${driver.label} — ${driver.fullName} (rostered)` : `${driver.label} (rostered)`}>
              <span className="mono">{driver.label}</span>
              <span className="db-roster-dot" aria-hidden="true" />
            </span>
          ) : (
            <span>{driver.label}</span>
          )}
        </span>
      ))}
    </span>
  );
}

export function DeliveriesView({ deliveries, asOf }: DeliveriesViewProps) {
  const flagged = deliveries.map((row) => ({ row, flag: deliveryFlag(row, asOf) }));
  const overdue = flagged.filter((d) => d.flag === "overdue").length;
  const today = flagged.filter((d) => d.flag === "today").length;
  const podDue = flagged.filter((d) => d.flag === "pod_due").length;

  return (
    <section className="db-del">
      <header className="db-del-head">
        <div>
          <h1 className="db-del-title">Open deliveries</h1>
          <p className="db-del-sub">
            Every delivery still in flight, across all days. Verify each is completed — overdue loads carry forward here
            so nothing slips when the day rolls over. As of {asOf}.
          </p>
        </div>
        <div className="db-del-stats" role="status">
          <span className="db-del-stat"><strong>{deliveries.length}</strong> open</span>
          <span className={`db-del-stat${overdue > 0 ? " is-overdue" : ""}`}><strong>{overdue}</strong> overdue</span>
          <span className={`db-del-stat${today > 0 ? " is-today" : ""}`}><strong>{today}</strong> due today</span>
          <span className="db-del-stat"><strong>{podDue}</strong> POD due</span>
        </div>
      </header>

      {deliveries.length === 0 ? (
        <div className="db-del-empty">
          <strong>All clear.</strong> No open deliveries — everything is POD-received or complete.
        </div>
      ) : (
        <div className="db-del-tablewrap">
          <table className="db-del-table">
            <caption className="db-sr-only">Open deliveries across all days</caption>
            <thead>
              <tr>
                <th>Flag</th>
                <th>Rate Con #</th>
                <th>Status</th>
                <th>Lane (PU → DEL)</th>
                <th>DEL Date</th>
                <th>DEL Appt</th>
                <th>DEL Status</th>
                <th>Driver(s)</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map(({ row, flag }) => (
                <tr key={row.id} className={`db-del-row db-del-${flag}`}>
                  <td><span className={`db-del-flag ${FLAG_META[flag].cls}`}>{FLAG_META[flag].label}</span></td>
                  <td className="mono db-del-ref">
                    <Link href={loadHref(row)} className="db-del-ref-link" title="Open in tracker to update status / POD">{row.ref}</Link>
                  </td>
                  <td><StatusPill status={row.status} /></td>
                  <td className="db-del-lane">
                    <span>{laneText(row.pickupCityState)}</span>
                    <span className="db-del-arrow" aria-hidden="true">→</span>
                    <span>{laneText(row.deliveryCityState)}</span>
                  </td>
                  <td className="mono">{row.deliveryDate ? row.deliveryDate.slice(0, 10) : "—"}</td>
                  <td className="mono dim">{apptCell(row.deliveryApptType, row.deliveryWindowStartIso, row.deliveryWindowEndIso)}</td>
                  <td className="trunc">{statusLabel(row.delStatusPreset, row.delStatusCustom)}</td>
                  <td><DriverList row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
