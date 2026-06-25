"use client";

import Link from "next/link";
import React from "react";
import type { DropLotSummary } from "@/server/reference";
import { ReferenceTabs } from "@/components/reference/reference-tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { UndoToast, useToast } from "@/components/ui/toast";
import { InfoIcon, LockIcon, PencilIcon, PinIcon, PlusIcon, TrashIcon, GripIcon } from "@/components/icons";

interface DropLotsManagerProps {
  initialDropLots: DropLotSummary[];
  canWrite: boolean;
}

interface LotForm {
  name: string;
  code: string;
  city: string;
  state: string;
  capacity: string;
  order: string;
  note: string;
}

const EMPTY_FORM: LotForm = { name: "", code: "", city: "", state: "", capacity: "", order: "", note: "" };

function formFromLot(lot: DropLotSummary): LotForm {
  return {
    name: lot.name,
    code: lot.code ?? "",
    city: lot.city,
    state: lot.state,
    capacity: lot.dailyCapacity == null ? "" : String(lot.dailyCapacity),
    order: String(lot.sortOrder),
    note: lot.note ?? ""
  };
}

function CapCell({ cap, max }: { cap: number | null; max: number }) {
  if (cap == null) {
    return (
      <div className="db-cap-cell">
        <div className="db-cap-top">
          <span className="db-cap-num faint">—</span>
          <span className="db-cap-unit">unset</span>
        </div>
        <div className="db-cap-bar"><div className="db-cap-fill unset" style={{ width: "100%" }} /></div>
      </div>
    );
  }
  const pct = max > 0 ? Math.min(100, Math.round((cap / max) * 100)) : 0;
  return (
    <div className="db-cap-cell">
      <div className="db-cap-top">
        <span className="db-cap-num">{cap}</span>
        <span className="db-cap-unit">/ day</span>
      </div>
      <div className="db-cap-bar"><div className="db-cap-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function DropLotsManager({ initialDropLots, canWrite }: DropLotsManagerProps) {
  const [dropLots, setDropLots] = React.useState<DropLotSummary[]>(initialDropLots);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // null = no form; "create" = new lot; a lot = editing it.
  const [formMode, setFormMode] = React.useState<null | "create" | DropLotSummary>(null);
  const [form, setForm] = React.useState<LotForm>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = React.useState<DropLotSummary | null>(null);
  const { toast, show, clear } = useToast();

  const maxCap = React.useMemo(
    () => Math.max(12, ...dropLots.map((l) => l.dailyCapacity ?? 0)),
    [dropLots]
  );

  async function mutate(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/reference/drop-lots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; dropLots?: DropLotSummary[] } | null;
      if (!response.ok || !payload?.dropLots) {
        throw new Error(payload?.error ?? "Request failed.");
      }
      setDropLots(payload.dropLots);
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

  function openEdit(lot: DropLotSummary) {
    setForm(formFromLot(lot));
    setError(null);
    setFormMode(lot);
  }

  function setField<K extends keyof LotForm>(key: K, value: LotForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submitForm() {
    const fields = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      note: form.note.trim() || null,
      city: form.city.trim(),
      state: form.state.trim(),
      sortOrder: form.order.trim() ? Number(form.order) : 0,
      dailyCapacity: form.capacity.trim() ? Number(form.capacity) : null
    };
    const ok =
      formMode === "create"
        ? await mutate({ action: "create_drop_lot", dropLot: fields })
        : await mutate({ action: "update_drop_lot", dropLotId: (formMode as DropLotSummary).id, fields });
    if (ok) {
      show({ message: formMode === "create" ? `Drop lot "${fields.name}" added.` : `Drop lot "${fields.name}" saved.` });
      setFormMode(null);
    }
  }

  async function confirmDelete(reason: string) {
    if (!deleteTarget) return;
    const ok = await mutate({ action: "delete_drop_lot", dropLotId: deleteTarget.id, reason });
    if (ok) {
      show({ message: `Drop lot "${deleteTarget.name}" removed.` });
      setDeleteTarget(null);
    }
    // On a 409 (in use by loads) mutate returns false and sets `error`, which the dialog shows; it stays open.
  }

  const formValid = form.name.trim() && form.city.trim() && form.state.trim();

  return (
    <div className="db-ref">
      <ReferenceTabs />
      <div className="db-ref-body">
        <div className="db-ref-head">
          <div>
            <h2 className="db-ref-h">Drop lots</h2>
            <div className="db-ref-desc">
              Lots that organize the daily board. {canWrite ? "Order, capacity, and flags here drive how the board renders." : "Read-only for your role."}
            </div>
          </div>
          <div className="db-ref-actions">
            {canWrite ? (
              <button type="button" className="db-btn primary" disabled={busy} onClick={openCreate}>
                <PlusIcon size={14} /> Add drop lot
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
            <strong>Order</strong> sets the board&apos;s section sequence · <strong>capacity</strong> drives the over-cap red count · <strong>note</strong> prints on the section header.
          </span>
        </div>

        {error && !deleteTarget && !formMode ? <p className="db-upload-error">{error}</p> : null}

        {dropLots.length === 0 ? (
          <EmptyState
            icon={<PinIcon size={22} />}
            title="No drop lots yet"
            copy={canWrite ? "Add a drop lot to organize the daily board for this region." : "No drop lots have been set up for this region yet."}
            action={canWrite ? { label: "Add drop lot", onClick: openCreate } : undefined}
          />
        ) : (
          <div className="db-card-table">
            <table className="db-table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Order</th>
                  <th>Lot</th>
                  <th style={{ width: 90 }}>Code</th>
                  <th style={{ width: 150 }}>Location</th>
                  <th style={{ width: 120 }}>Capacity</th>
                  {canWrite ? <th className="right" style={{ width: 88 }}>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {dropLots.map((lot, index) => (
                  <tr key={lot.id} className={`db-row${index % 2 ? " odd" : ""}`}>
                    <td>
                      <span className="db-ord"><span className="grip" aria-hidden="true"><GripIcon size={12} /></span><span className="n">{lot.sortOrder}</span></span>
                    </td>
                    <td>
                      <div className="strong">{lot.name}</div>
                      {lot.note ? <div className="db-subnote">{lot.note}</div> : null}
                    </td>
                    <td className="mono dim">{lot.code ?? <span className="faint">—</span>}</td>
                    <td>
                      {lot.city}
                      <span className="st" style={{ color: "var(--db-fg-dim)", fontSize: "var(--db-text-xs)" }}>, {lot.state}</span>
                    </td>
                    <td><CapCell cap={lot.dailyCapacity} max={maxCap} /></td>
                    {canWrite ? (
                      <td className="actions right">
                        <span className="db-rowbtns">
                          <button type="button" className="db-iconbtn-sm" title="Edit drop lot" disabled={busy} onClick={() => openEdit(lot)}>
                            <PencilIcon size={15} />
                          </button>
                          <button type="button" className="db-iconbtn-sm danger" title="Remove drop lot" disabled={busy} onClick={() => setDeleteTarget(lot)}>
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
          eyebrow="Reference · Drop lots"
          title={formMode === "create" ? "Add drop lot" : `Edit ${(formMode as DropLotSummary).name}`}
          width="wide"
          busy={busy}
          onClose={() => setFormMode(null)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => setFormMode(null)}>
                Cancel
              </button>
              <button type="button" className="db-btn primary" disabled={busy || !formValid} aria-busy={busy} onClick={() => void submitForm()}>
                {busy ? "Saving…" : formMode === "create" ? "Add drop lot" : "Save drop lot"}
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
              Name
              <input className="db-input" value={form.name} onChange={(event) => setField("name", event.target.value)} required />
            </label>
            <label className="db-field-label">
              Code
              <input className="db-input mono" value={form.code} maxLength={12} onChange={(event) => setField("code", event.target.value)} />
              <span className="db-field-hint">≤ 12 chars</span>
            </label>
            <label className="db-field-label">
              City
              <input className="db-input" value={form.city} onChange={(event) => setField("city", event.target.value)} required />
            </label>
            <label className="db-field-label">
              State
              <input className="db-input" value={form.state} maxLength={40} onChange={(event) => setField("state", event.target.value)} required />
            </label>
            <label className="db-field-label">
              Daily capacity
              <input className="db-input mono" type="number" min="0" value={form.capacity} onChange={(event) => setField("capacity", event.target.value)} />
              <span className="db-field-hint">slots/day · over-cap shows red on the board</span>
            </label>
            <label className="db-field-label">
              Board order
              <input className="db-input mono" type="number" min="0" value={form.order} onChange={(event) => setField("order", event.target.value)} />
              <span className="db-field-hint">section position</span>
            </label>
            <label className="db-field-label db-form-full">
              Note
              <textarea className="db-input" value={form.note} maxLength={500} onChange={(event) => setField("note", event.target.value)} />
              <span className="db-field-hint">shown on the board section header</span>
            </label>
            {error ? <p className="db-upload-error db-form-full">{error}</p> : null}
            <button type="submit" hidden />
          </form>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Remove drop lot"
          message={
            <>
              Remove drop lot <strong>{deleteTarget.name}{deleteTarget.code ? ` (${deleteTarget.code})` : ""}</strong>? Loads booked into it will lose their section.
            </>
          }
          reason={{ label: "Reason for removal", placeholder: "e.g. Lot decommissioned" }}
          destructive
          confirmLabel="Remove drop lot"
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
