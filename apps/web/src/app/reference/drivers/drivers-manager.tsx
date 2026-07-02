"use client";

import Link from "next/link";
import React from "react";
import type { DriverSummary, DropLotSummary } from "@/server/reference";
import { ReferenceTabs } from "@/components/reference/reference-tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Toggle } from "@/components/ui/toggle";
import { UndoToast, useToast } from "@/components/ui/toast";
import { DriverIcon, InfoIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/icons";

type DriverAttribute = DriverSummary["attributes"][number];
type DayOfWeek = DriverSummary["scheduleDays"][number];

const DAYS: DayOfWeek[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

const ATTRIBUTE_LABELS: Record<DriverAttribute, string> = {
  LTL_CERT: "LTL cert",
  SLEEPER: "Sleeper",
  TURNS_ONLY: "Turns only",
  DEDICATED: "Dedicated",
  REGIONAL: "Regional",
  FLEX: "Flex",
  SHUTTLE: "Shuttle",
  PTP: "PTP"
};

const TIME_ZONES = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Los_Angeles", label: "Pacific" }
] as const;

/** "MON–FRI" for contiguous runs (incl. weekend wraps like FRI–MON), else "MON · WED · FRI". */
function formatScheduleDays(days: DayOfWeek[]): string {
  const set = new Set(days);
  if (set.size === 0) return "—";
  if (set.size === 7) return "Every day";
  for (let start = 0; start < 7; start += 1) {
    const run = Array.from({ length: set.size }, (_, i) => DAYS[(start + i) % 7]);
    if (run.every((day) => set.has(day))) {
      return set.size === 1 ? run[0] : `${run[0]}–${run[run.length - 1]}`;
    }
  }
  return DAYS.filter((day) => set.has(day)).join(" · ");
}

function timeZoneLabel(timeZone: string | null): string {
  if (!timeZone) return "";
  return TIME_ZONES.find((zone) => zone.value === timeZone)?.label ?? timeZone;
}

interface DriversManagerProps {
  initialDrivers: DriverSummary[];
  dropLots: DropLotSummary[];
  canWrite: boolean;
}

interface DriverForm {
  code: string;
  fullName: string;
  phone: string;
  homeDropLotId: string;
  active: boolean;
  attributes: DriverAttribute[];
  scheduleDays: DayOfWeek[];
  scheduleStart: string;
  scheduleTimeZone: string;
  scheduleNote: string;
}

const EMPTY_FORM: DriverForm = {
  code: "",
  fullName: "",
  phone: "",
  homeDropLotId: "",
  active: true,
  attributes: [],
  scheduleDays: [],
  scheduleStart: "",
  scheduleTimeZone: "America/New_York",
  scheduleNote: ""
};

function formFromDriver(driver: DriverSummary): DriverForm {
  return {
    code: driver.code,
    fullName: driver.fullName,
    phone: driver.phone ?? "",
    homeDropLotId: driver.homeDropLotId ?? "",
    active: driver.active,
    attributes: driver.attributes,
    scheduleDays: driver.scheduleDays,
    scheduleStart: driver.scheduleStart ?? "",
    scheduleTimeZone: driver.scheduleTimeZone ?? "America/New_York",
    scheduleNote: driver.scheduleNote ?? ""
  };
}

export function DriversManager({ initialDrivers, dropLots, canWrite }: DriversManagerProps) {
  const [drivers, setDrivers] = React.useState<DriverSummary[]>(initialDrivers);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // null = no form; "create" = new driver; a driver = editing it.
  const [formMode, setFormMode] = React.useState<null | "create" | DriverSummary>(null);
  const [form, setForm] = React.useState<DriverForm>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = React.useState<DriverSummary | null>(null);
  const { toast, show, clear } = useToast();

  async function mutate(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/reference/drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; drivers?: DriverSummary[] } | null;
      if (!response.ok || !payload?.drivers) {
        throw new Error(payload?.error ?? "Request failed.");
      }
      setDrivers(payload.drivers);
      return true;
    } catch (mutateError) {
      setError(mutateError instanceof Error ? mutateError.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setError(null);
    setFormMode("create");
  }

  function openEdit(driver: DriverSummary) {
    setForm(formFromDriver(driver));
    setError(null);
    setFormMode(driver);
  }

  function setField<K extends keyof DriverForm>(key: K, value: DriverForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleAttribute(attribute: DriverAttribute) {
    setForm((prev) => ({
      ...prev,
      attributes: prev.attributes.includes(attribute)
        ? prev.attributes.filter((item) => item !== attribute)
        : [...prev.attributes, attribute]
    }));
  }

  function toggleDay(day: DayOfWeek) {
    setForm((prev) => ({
      ...prev,
      scheduleDays: prev.scheduleDays.includes(day)
        ? prev.scheduleDays.filter((item) => item !== day)
        : [...prev.scheduleDays, day]
    }));
  }

  async function submitForm() {
    const fields = {
      code: form.code.trim().toUpperCase(),
      fullName: form.fullName.trim(),
      phone: form.phone.trim() || null,
      homeDropLotId: form.homeDropLotId || null,
      active: form.active,
      attributes: form.attributes,
      scheduleDays: form.scheduleDays,
      scheduleStart: form.scheduleStart || null,
      scheduleTimeZone: form.scheduleStart ? form.scheduleTimeZone : null,
      scheduleNote: form.scheduleNote.trim() || null
    };
    const ok =
      formMode === "create"
        ? await mutate({ action: "create_driver", driver: fields })
        : await mutate({ action: "update_driver", driverId: (formMode as DriverSummary).id, fields });
    if (ok) {
      show({ message: formMode === "create" ? `Driver ${fields.code} added.` : `Driver ${fields.code} saved.` });
      setFormMode(null);
    }
  }

  async function confirmDelete(reason: string) {
    if (!deleteTarget) return;
    const ok = await mutate({ action: "delete_driver", driverId: deleteTarget.id, reason });
    if (ok) {
      show({ message: `Driver ${deleteTarget.code} removed.` });
      setDeleteTarget(null);
    }
    // On 409 (in use by loads/legs) mutate returns false and sets `error`; the dialog stays open.
  }

  const formValid = form.code.trim() && form.fullName.trim();

  return (
    <div className="db-ref">
      <ReferenceTabs />
      <div className="db-ref-body">
        <div className="db-ref-head">
          <div>
            <h2 className="db-ref-h">Drivers</h2>
            <div className="db-ref-desc">
              The booking-plan roster: who runs empty, from where, on which days.{" "}
              {canWrite ? "Codes here resolve driver names on the tracker." : "Read-only for your role."}
            </div>
          </div>
          <div className="db-ref-actions">
            {canWrite ? (
              <button type="button" className="db-btn primary" disabled={busy} onClick={openCreate}>
                <PlusIcon size={14} /> Add driver
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
            <strong>Code</strong> is the roster handle (unique per region) · <strong>schedule</strong> is the driver&apos;s
            usual empty days &amp; local start time · <strong>attributes</strong> gate what freight they can take.
          </span>
        </div>

        {error && !deleteTarget && !formMode ? <p className="db-upload-error">{error}</p> : null}

        {drivers.length === 0 ? (
          <EmptyState
            icon={<DriverIcon size={22} />}
            title="No drivers yet"
            copy={canWrite ? "Add drivers to build the booking-plan roster for this region." : "No drivers have been set up for this region yet."}
            action={canWrite ? { label: "Add driver", onClick: openCreate } : undefined}
          />
        ) : (
          <div className="db-card-table">
            <table className="db-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Code</th>
                  <th>Driver</th>
                  <th style={{ width: 150 }}>Home yard</th>
                  <th style={{ width: 160 }}>Schedule</th>
                  <th>Attributes</th>
                  <th style={{ width: 92 }}>Status</th>
                  {canWrite ? <th className="right" style={{ width: 88 }}>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {drivers.map((driver, index) => (
                  <tr key={driver.id} className={`db-row${index % 2 ? " odd" : ""}`}>
                    <td className="mono">
                      <span className="strong">{driver.code}</span>
                    </td>
                    <td>
                      <div className="strong">{driver.fullName}</div>
                      {driver.phone ? <div className="db-subnote mono">{driver.phone}</div> : null}
                    </td>
                    <td>
                      {driver.homeDropLot ? (
                        <>
                          <div className="mono">{driver.homeDropLot.code ?? driver.homeDropLot.name}</div>
                          {driver.homeDropLot.code ? <div className="db-subnote">{driver.homeDropLot.name}</div> : null}
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      <div>{formatScheduleDays(driver.scheduleDays)}</div>
                      {driver.scheduleStart ? (
                        <div className="db-subnote mono">
                          {driver.scheduleStart}
                          {driver.scheduleTimeZone ? ` ${timeZoneLabel(driver.scheduleTimeZone)}` : ""}
                        </div>
                      ) : null}
                      {driver.scheduleNote ? <div className="db-subnote">{driver.scheduleNote}</div> : null}
                    </td>
                    <td>
                      {driver.attributes.length > 0 ? (
                        <span className="db-flags">
                          {driver.attributes.map((attribute) => (
                            <span key={attribute} className="db-flag">
                              {ATTRIBUTE_LABELS[attribute]}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`db-flag${driver.active ? " on" : " muted"}`}>
                        {driver.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    {canWrite ? (
                      <td className="actions right">
                        <span className="db-rowbtns">
                          <button type="button" className="db-iconbtn-sm" title="Edit driver" disabled={busy} onClick={() => openEdit(driver)}>
                            <PencilIcon size={15} />
                          </button>
                          <button type="button" className="db-iconbtn-sm danger" title="Remove driver" disabled={busy} onClick={() => setDeleteTarget(driver)}>
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

      {formMode ? (
        <Modal
          eyebrow="Reference · Drivers"
          title={formMode === "create" ? "Add driver" : `Edit ${(formMode as DriverSummary).code}`}
          width="wide"
          busy={busy}
          onClose={() => setFormMode(null)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => setFormMode(null)}>
                Cancel
              </button>
              <button type="button" className="db-btn primary" disabled={busy || !formValid} aria-busy={busy} onClick={() => void submitForm()}>
                {busy ? "Saving…" : formMode === "create" ? "Add driver" : "Save driver"}
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
              Code
              <input className="db-input mono" value={form.code} maxLength={16} onChange={(event) => setField("code", event.target.value)} required />
              <span className="db-field-hint">roster handle, unique per region — e.g. REES2</span>
            </label>
            <label className="db-field-label">
              Full name
              <input className="db-input" value={form.fullName} onChange={(event) => setField("fullName", event.target.value)} required />
            </label>
            <label className="db-field-label">
              Phone
              <input className="db-input mono" value={form.phone} maxLength={40} onChange={(event) => setField("phone", event.target.value)} />
              <span className="db-field-hint">optional</span>
            </label>
            <label className="db-field-label">
              Home yard
              <select className="db-input" value={form.homeDropLotId} onChange={(event) => setField("homeDropLotId", event.target.value)}>
                <option value="">— None —</option>
                {dropLots.map((lot) => (
                  <option key={lot.id} value={lot.id}>
                    {lot.code ? `${lot.code} — ${lot.name}` : lot.name}
                  </option>
                ))}
              </select>
              <span className="db-field-hint">groups the driver on the booking plan</span>
            </label>

            <div className="db-field-label db-form-full">
              Schedule days
              <div className="db-chiprow" role="group" aria-label="Schedule days">
                {DAYS.map((day) => {
                  const on = form.scheduleDays.includes(day);
                  return (
                    <button key={day} type="button" className={`db-chip-toggle day${on ? " on" : ""}`} aria-pressed={on} disabled={busy} onClick={() => toggleDay(day)}>
                      {day}
                    </button>
                  );
                })}
              </div>
              <span className="db-field-hint">days the driver is expected empty and available for a backhaul</span>
            </div>

            <label className="db-field-label">
              Start time
              <input className="db-input mono" type="time" value={form.scheduleStart} onChange={(event) => setField("scheduleStart", event.target.value)} />
              <span className="db-field-hint">local wall-clock, e.g. 05:00</span>
            </label>
            <label className="db-field-label">
              Time zone
              <select className="db-input" value={form.scheduleTimeZone} disabled={!form.scheduleStart} onChange={(event) => setField("scheduleTimeZone", event.target.value)}>
                {TIME_ZONES.map((zone) => (
                  <option key={zone.value} value={zone.value}>
                    {zone.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="db-field-label db-form-full">
              Attributes
              <div className="db-chiprow" role="group" aria-label="Driver attributes">
                {(Object.keys(ATTRIBUTE_LABELS) as DriverAttribute[]).map((attribute) => {
                  const on = form.attributes.includes(attribute);
                  return (
                    <button key={attribute} type="button" className={`db-chip-toggle${on ? " on" : ""}`} aria-pressed={on} disabled={busy} onClick={() => toggleAttribute(attribute)}>
                      {ATTRIBUTE_LABELS[attribute]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="db-field-label">
              Status
              <Toggle on={form.active} onChange={(next) => setField("active", next)} label={form.active ? "Active" : "Inactive"} disabled={busy} />
              <span className="db-field-hint">inactive drivers stay off the booking plan</span>
            </div>
            <label className="db-field-label">
              Schedule note
              <input className="db-input" value={form.scheduleNote} maxLength={500} onChange={(event) => setField("scheduleNote", event.target.value)} />
              <span className="db-field-hint">e.g. PHILLY &amp; ARCHY only</span>
            </label>

            {error ? <p className="db-upload-error db-form-full">{error}</p> : null}
            <button type="submit" hidden />
          </form>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Remove driver"
          message={
            <>
              Remove driver <strong>{deleteTarget.code}</strong> ({deleteTarget.fullName})? Loads that already reference
              them keep their history; drivers still on active loads can&apos;t be removed.
            </>
          }
          reason={{ label: "Reason for removal", placeholder: "e.g. No longer with the fleet" }}
          destructive
          confirmLabel="Remove driver"
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
