"use client";

import Link from "next/link";
import React from "react";
import type { BookingPlanEntrySummary, DirectCustomerSummary, DriverSummary } from "@/server/reference";
import { ReferenceTabs } from "@/components/reference/reference-tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { UndoToast, useToast } from "@/components/ui/toast";
import { BoxIcon, CalendarIcon, InfoIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/icons";

type BookingPlanStatus = BookingPlanEntrySummary["status"];

const STATUS_LABELS: Record<BookingPlanStatus, string> = {
  NEEDS_BACKHAUL: "Needs backhaul",
  SOURCING: "Sourcing",
  BOOKED: "Booked"
};

function StatusPill({ status }: { status: BookingPlanStatus }) {
  const cls = status === "BOOKED" ? " on" : status === "NEEDS_BACKHAUL" ? " warn" : "";
  return <span className={`db-flag${cls}`}>{STATUS_LABELS[status]}</span>;
}

interface BookingPlanManagerProps {
  initialEntries: BookingPlanEntrySummary[];
  initialPlanDate: string; // "YYYY-MM-DD"
  drivers: DriverSummary[];
  directCustomers: DirectCustomerSummary[];
  canWrite: boolean;
}

interface EntryForm {
  planDate: string;
  driverId: string;
  expectedEmptyAt: string;
  emptyCity: string;
  emptyState: string;
  emptyCityAlt: string;
  backhaulNote: string;
  status: "NEEDS_BACKHAUL" | "SOURCING";
  puCityDh: string;
  puTimes: string;
  delCityDh: string;
  delTimes: string;
}

function emptyForm(planDate: string): EntryForm {
  return {
    planDate,
    driverId: "",
    expectedEmptyAt: "",
    emptyCity: "",
    emptyState: "",
    emptyCityAlt: "",
    backhaulNote: "",
    status: "NEEDS_BACKHAUL",
    puCityDh: "",
    puTimes: "",
    delCityDh: "",
    delTimes: ""
  };
}

function formFromEntry(entry: BookingPlanEntrySummary): EntryForm {
  return {
    planDate: entry.planDate,
    driverId: entry.driverId,
    expectedEmptyAt: entry.expectedEmptyAt ?? "",
    emptyCity: entry.emptyCity ?? "",
    emptyState: entry.emptyState ?? "",
    emptyCityAlt: entry.emptyCityAlt ?? "",
    backhaulNote: entry.backhaulNote ?? "",
    status: entry.status === "SOURCING" ? "SOURCING" : "NEEDS_BACKHAUL",
    puCityDh: entry.puCityDh ?? "",
    puTimes: entry.puTimes ?? "",
    delCityDh: entry.delCityDh ?? "",
    delTimes: entry.delTimes ?? ""
  };
}

export function BookingPlanManager({
  initialEntries,
  initialPlanDate,
  drivers,
  directCustomers,
  canWrite
}: BookingPlanManagerProps) {
  const [entries, setEntries] = React.useState<BookingPlanEntrySummary[]>(initialEntries);
  const [planDate, setPlanDate] = React.useState(initialPlanDate);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // null = no form; "create" = new entry; an entry = editing it.
  const [formMode, setFormMode] = React.useState<null | "create" | BookingPlanEntrySummary>(null);
  const [form, setForm] = React.useState<EntryForm>(emptyForm(initialPlanDate));
  const [deleteTarget, setDeleteTarget] = React.useState<BookingPlanEntrySummary | null>(null);
  const { toast, show, clear } = useToast();

  const activeDrivers = React.useMemo(() => drivers.filter((driver) => driver.active), [drivers]);

  const fetchEntries = React.useCallback(async (date: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/reference/booking-plan?planDate=${encodeURIComponent(date)}`);
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; entries?: BookingPlanEntrySummary[] }
        | null;
      if (!response.ok || !payload?.entries) {
        throw new Error(payload?.error ?? "Request failed.");
      }
      setEntries(payload.entries);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  function changeDate(next: string) {
    if (!next) return;
    setPlanDate(next);
    void fetchEntries(next);
  }

  /** POST a mutation, then re-fetch the selected day (POST returns all days). */
  async function mutate(body: Record<string, unknown>): Promise<{ ok: boolean; bookedLoadId: string | null }> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/reference/booking-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; entries?: BookingPlanEntrySummary[]; bookedLoadId?: string | null }
        | null;
      if (!response.ok || !payload?.entries) {
        throw new Error(payload?.error ?? "Request failed.");
      }
      return { ok: true, bookedLoadId: payload.bookedLoadId ?? null };
    } catch (mutateError) {
      setError(mutateError instanceof Error ? mutateError.message : "Request failed.");
      return { ok: false, bookedLoadId: null };
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setForm(emptyForm(planDate));
    setError(null);
    setFormMode("create");
  }

  function openEdit(entry: BookingPlanEntrySummary) {
    setForm(formFromEntry(entry));
    setError(null);
    setFormMode(entry);
  }

  function setField<K extends keyof EntryForm>(key: K, value: EntryForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submitForm() {
    const fields = {
      planDate: form.planDate,
      driverId: form.driverId,
      expectedEmptyAt: form.expectedEmptyAt || null,
      emptyCity: form.emptyCity.trim() || null,
      emptyState: form.emptyState.trim() || null,
      emptyCityAlt: form.emptyCityAlt.trim() || null,
      backhaulNote: form.backhaulNote.trim() || null,
      status: form.status,
      puCityDh: form.puCityDh.trim() || null,
      puTimes: form.puTimes.trim() || null,
      delCityDh: form.delCityDh.trim() || null,
      delTimes: form.delTimes.trim() || null
    };
    const result =
      formMode === "create"
        ? await mutate({ action: "create_booking_plan_entry", entry: fields })
        : await mutate({
            action: "update_booking_plan_entry",
            entryId: (formMode as BookingPlanEntrySummary).id,
            fields
          });
    if (result.ok) {
      const driverCode = drivers.find((driver) => driver.id === fields.driverId)?.code ?? "entry";
      show({ message: formMode === "create" ? `Plan line for ${driverCode} added.` : `Plan line for ${driverCode} saved.` });
      setFormMode(null);
      await fetchEntries(planDate);
    }
  }

  async function bookEntry(entry: BookingPlanEntrySummary) {
    const result = await mutate({ action: "book_booking_plan_entry", entryId: entry.id });
    if (result.ok) {
      show({ message: `Booked — load created for ${entry.driver.code}, headed home.` });
      await fetchEntries(planDate);
    }
  }

  async function confirmDelete(reason: string) {
    if (!deleteTarget) return;
    const result = await mutate({ action: "delete_booking_plan_entry", entryId: deleteTarget.id, reason });
    if (result.ok) {
      show({ message: `Plan line for ${deleteTarget.driver.code} removed.` });
      setDeleteTarget(null);
      await fetchEntries(planDate);
    }
    // On 409 (already booked) mutate returns ok=false and sets `error`; the dialog stays open.
  }

  const formValid = form.driverId && form.planDate;
  const needCount = entries.filter((entry) => entry.status === "NEEDS_BACKHAUL").length;
  const bookedCount = entries.filter((entry) => entry.status === "BOOKED").length;

  return (
    <div className="db-ref">
      <ReferenceTabs />
      <div className="db-ref-body">
        <div className="db-ref-head">
          <div>
            <h2 className="db-ref-h">Daily booking plan</h2>
            <div className="db-ref-desc">
              Drivers running empty on the plan date — source freight to bring each one home to Leesport loaded.{" "}
              {canWrite ? "" : "Read-only for your role."}
            </div>
          </div>
          <div className="db-ref-actions">
            <label className="db-bp-date" title="Plan date">
              <CalendarIcon size={14} />
              <input
                className="db-input mono"
                type="date"
                value={planDate}
                disabled={busy}
                onChange={(event) => changeDate(event.target.value)}
              />
            </label>
            {canWrite ? (
              <button type="button" className="db-btn primary" disabled={busy} onClick={openCreate}>
                <PlusIcon size={14} /> Add plan line
              </button>
            ) : (
              <span className="db-ro-chip">
                <LockIcon size={13} /> Read-only
              </span>
            )}
            <Link href="/" className="db-btn db-btn-ghost">
              Back to board
            </Link>
          </div>
        </div>

        <div className="db-ref-note">
          <InfoIcon size={15} />
          <span>
            <strong>{needCount}</strong> need a backhaul · <strong>{bookedCount}</strong> booked — booking creates a
            tracked load on the board with the driver already assigned.
          </span>
        </div>

        {error && !deleteTarget && !formMode ? <p className="db-upload-error">{error}</p> : null}

        <div className="db-bp-layout">
          <div>
            {entries.length === 0 ? (
              <EmptyState
                icon={<CalendarIcon size={22} />}
                title="No plan lines for this date"
                copy={
                  canWrite
                    ? "Add the drivers expected to run empty on this date."
                    : "No booking plan has been recorded for this date yet."
                }
                action={canWrite ? { label: "Add plan line", onClick: openCreate } : undefined}
              />
            ) : (
              <div className="db-card-table">
                <table className="db-table">
                  <thead>
                    <tr>
                      <th style={{ width: 120 }}>Driver</th>
                      <th>Empty</th>
                      <th>Backhaul</th>
                      <th style={{ width: 150 }}>PU</th>
                      <th style={{ width: 150 }}>DEL</th>
                      <th style={{ width: 128 }}>Status</th>
                      {canWrite ? <th className="right" style={{ width: 150 }}>Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, index) => (
                      <tr key={entry.id} className={`db-row${index % 2 ? " odd" : ""}`}>
                        <td>
                          <div className="mono strong">{entry.driver.code}</div>
                          <div className="db-subnote">{entry.driver.fullName}</div>
                        </td>
                        <td>
                          <div>
                            {entry.emptyCity ? (
                              <>
                                {entry.emptyCity}
                                {entry.emptyState ? (
                                  <span className="st" style={{ color: "var(--db-fg-dim)", fontSize: "var(--db-text-xs)" }}>
                                    , {entry.emptyState}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span className="faint">—</span>
                            )}
                            {entry.expectedEmptyAt ? <span className="db-bp-time mono"> {entry.expectedEmptyAt}</span> : null}
                          </div>
                          {entry.emptyCityAlt ? <div className="db-subnote">alt: {entry.emptyCityAlt}</div> : null}
                        </td>
                        <td>
                          {entry.backhaulNote ? <span className="db-subnote">{entry.backhaulNote}</span> : <span className="faint">—</span>}
                        </td>
                        <td>
                          {entry.puCityDh ? <div>{entry.puCityDh}</div> : <span className="faint">—</span>}
                          {entry.puTimes ? <div className="db-subnote mono">{entry.puTimes}</div> : null}
                        </td>
                        <td>
                          {entry.delCityDh ? <div>{entry.delCityDh}</div> : <span className="faint">—</span>}
                          {entry.delTimes ? <div className="db-subnote mono">{entry.delTimes}</div> : null}
                        </td>
                        <td>
                          <StatusPill status={entry.status} />
                          {entry.status === "BOOKED" ? (
                            entry.sourcedLoad ? (
                              <div className="db-subnote">
                                <Link href="/" className="db-bp-loadlink mono" title="Open the board">
                                  {entry.sourcedLoad.loadNumber ?? `#${entry.sourcedLoad.id.slice(-6)}`}
                                </Link>
                              </div>
                            ) : (
                              <div className="db-subnote faint">load removed</div>
                            )
                          ) : null}
                        </td>
                        {canWrite ? (
                          <td className="actions right">
                            <span className="db-rowbtns">
                              {entry.status !== "BOOKED" ? (
                                <button
                                  type="button"
                                  className="db-btn primary db-btn-sm"
                                  disabled={busy}
                                  onClick={() => void bookEntry(entry)}
                                >
                                  Book
                                </button>
                              ) : null}
                              <button type="button" className="db-iconbtn-sm" title="Edit plan line" disabled={busy} onClick={() => openEdit(entry)}>
                                <PencilIcon size={15} />
                              </button>
                              <button
                                type="button"
                                className="db-iconbtn-sm danger"
                                title="Remove plan line"
                                disabled={busy || entry.status === "BOOKED"}
                                onClick={() => setDeleteTarget(entry)}
                              >
                                <TrashIcon size={15} />
                              </button>
                            </span>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <aside className="db-bp-side" aria-label="Direct customers">
            <div className="db-bp-side-head">
              <BoxIcon size={15} />
              <span>Direct customers</span>
            </div>
            <div className="db-bp-side-sub">Guaranteed recurring freight — pull from here first.</div>
            {directCustomers.length === 0 ? (
              <div className="db-bp-side-empty faint">None set up yet.</div>
            ) : (
              <ul className="db-bp-side-list">
                {directCustomers.map((customer) => (
                  <li key={customer.id} className="db-bp-side-row">
                    <span className="db-bp-side-name">{customer.name}</span>
                    {customer.cadenceCount != null && customer.cadencePeriod != null ? (
                      <span className="db-flag on">
                        {customer.cadenceCount}/{customer.cadencePeriod === "DAY" ? "day" : "wk"}
                      </span>
                    ) : (
                      <span className="db-flag muted">ad hoc</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Link href="/reference/direct-customers" className="db-bp-side-link">
              Manage direct customers
            </Link>
          </aside>
        </div>
      </div>

      {formMode ? (
        <Modal
          eyebrow="Booking plan"
          title={formMode === "create" ? "Add plan line" : `Edit ${(formMode as BookingPlanEntrySummary).driver.code}`}
          width="wide"
          busy={busy}
          onClose={() => setFormMode(null)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => setFormMode(null)}>
                Cancel
              </button>
              <button type="button" className="db-btn primary" disabled={busy || !formValid} aria-busy={busy} onClick={() => void submitForm()}>
                {busy ? "Saving…" : formMode === "create" ? "Add plan line" : "Save plan line"}
              </button>
            </>
          }
        >
          <form
            className="db-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              if (formValid) void submitForm();
            }}
          >
            <label className="db-field-label">
              Driver
              <select className="db-input" value={form.driverId} onChange={(event) => setField("driverId", event.target.value)} required>
                <option value="">— Select driver —</option>
                {activeDrivers.map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.code} — {driver.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="db-field-label">
              Plan date
              <input className="db-input mono" type="date" value={form.planDate} onChange={(event) => setField("planDate", event.target.value)} required />
              <span className="db-field-hint">the day the driver runs empty</span>
            </label>
            <label className="db-field-label">
              Empty time
              <input className="db-input mono" type="time" value={form.expectedEmptyAt} onChange={(event) => setField("expectedEmptyAt", event.target.value)} />
              <span className="db-field-hint">local wall-clock</span>
            </label>
            <label className="db-field-label">
              Status
              <select
                className="db-input"
                value={form.status}
                onChange={(event) => setField("status", event.target.value as EntryForm["status"])}
              >
                <option value="NEEDS_BACKHAUL">Needs backhaul</option>
                <option value="SOURCING">Sourcing</option>
              </select>
              <span className="db-field-hint">Booked is set by the Book action</span>
            </label>
            <label className="db-field-label">
              Empty city
              <input className="db-input" value={form.emptyCity} onChange={(event) => setField("emptyCity", event.target.value)} />
            </label>
            <label className="db-field-label">
              Empty state
              <input className="db-input" value={form.emptyState} maxLength={40} onChange={(event) => setField("emptyState", event.target.value)} />
            </label>
            <label className="db-field-label db-form-full">
              Alt empty location
              <input className="db-input" value={form.emptyCityAlt} maxLength={160} onChange={(event) => setField("emptyCityAlt", event.target.value)} />
              <span className="db-field-hint">the sheet&apos;s EMPTY CITY2</span>
            </label>
            <label className="db-field-label db-form-full">
              Backhaul note
              <textarea className="db-input" value={form.backhaulNote} maxLength={500} onChange={(event) => setField("backhaulNote", event.target.value)} />
              <span className="db-field-hint">freight being sourced — copied to the load&apos;s coordinator notes on book</span>
            </label>
            <label className="db-field-label">
              PU city &amp; DH
              <input className="db-input" value={form.puCityDh} maxLength={200} onChange={(event) => setField("puCityDh", event.target.value)} />
              <span className="db-field-hint">e.g. READING PA +25</span>
            </label>
            <label className="db-field-label">
              PU times
              <input className="db-input mono" value={form.puTimes} maxLength={200} onChange={(event) => setField("puTimes", event.target.value)} />
            </label>
            <label className="db-field-label">
              DEL city &amp; DH
              <input className="db-input" value={form.delCityDh} maxLength={200} onChange={(event) => setField("delCityDh", event.target.value)} />
            </label>
            <label className="db-field-label">
              DEL times
              <input className="db-input mono" value={form.delTimes} maxLength={200} onChange={(event) => setField("delTimes", event.target.value)} />
            </label>
            {error ? <p className="db-upload-error db-form-full">{error}</p> : null}
            <button type="submit" hidden />
          </form>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Remove plan line"
          message={
            <>
              Remove the plan line for <strong>{deleteTarget.driver.code}</strong> on {deleteTarget.planDate}? Booked
              lines can&apos;t be removed while their load exists.
            </>
          }
          reason={{ label: "Reason for removal", placeholder: "e.g. Driver not empty after all" }}
          destructive
          confirmLabel="Remove plan line"
          busyLabel="Removing…"
          busy={busy}
          error={error}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={(reason) => void confirmDelete(reason)}
        />
      ) : null}

      <UndoToast toast={toast} onDismiss={clear} />
    </div>
  );
}
