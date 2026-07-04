"use client";

import Link from "next/link";
import React from "react";
import type { DirectCustomerSummary } from "@/server/reference";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { UndoToast, useToast } from "@/components/ui/toast";
import { BoxIcon, InfoIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/icons";

type CadencePeriod = NonNullable<DirectCustomerSummary["cadencePeriod"]>;

interface DirectCustomersManagerProps {
  initialDirectCustomers: DirectCustomerSummary[];
  canWrite: boolean;
}

interface CustomerForm {
  name: string;
  cadenceCount: string;
  cadencePeriod: "" | CadencePeriod;
  notes: string;
}

const EMPTY_FORM: CustomerForm = { name: "", cadenceCount: "", cadencePeriod: "", notes: "" };

function formFromCustomer(customer: DirectCustomerSummary): CustomerForm {
  return {
    name: customer.name,
    cadenceCount: customer.cadenceCount == null ? "" : String(customer.cadenceCount),
    cadencePeriod: customer.cadencePeriod ?? "",
    notes: customer.notes ?? ""
  };
}

function CadenceCell({ customer }: { customer: DirectCustomerSummary }) {
  if (customer.cadenceCount == null || customer.cadencePeriod == null) {
    return <span className="faint">—</span>;
  }
  return (
    <span className="db-od">
      <span className="pt mono">{customer.cadenceCount}</span>
      <span className="st">/ {customer.cadencePeriod === "DAY" ? "day" : "week"}</span>
    </span>
  );
}

export function DirectCustomersManager({ initialDirectCustomers, canWrite }: DirectCustomersManagerProps) {
  const [customers, setCustomers] = React.useState<DirectCustomerSummary[]>(initialDirectCustomers);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // null = no form; "create" = new customer; a customer = editing it.
  const [formMode, setFormMode] = React.useState<null | "create" | DirectCustomerSummary>(null);
  const [form, setForm] = React.useState<CustomerForm>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = React.useState<DirectCustomerSummary | null>(null);
  const { toast, show, clear } = useToast();

  async function mutate(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/reference/direct-customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; directCustomers?: DirectCustomerSummary[] }
        | null;
      if (!response.ok || !payload?.directCustomers) {
        throw new Error(payload?.error ?? "Request failed.");
      }
      setCustomers(payload.directCustomers);
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

  function openEdit(customer: DirectCustomerSummary) {
    setForm(formFromCustomer(customer));
    setError(null);
    setFormMode(customer);
  }

  function setField<K extends keyof CustomerForm>(key: K, value: CustomerForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submitForm() {
    const fields = {
      name: form.name.trim(),
      cadenceCount: form.cadenceCount.trim() ? Number(form.cadenceCount) : null,
      cadencePeriod: form.cadencePeriod || null,
      notes: form.notes.trim() || null
    };
    const ok =
      formMode === "create"
        ? await mutate({ action: "create_direct_customer", directCustomer: fields })
        : await mutate({
            action: "update_direct_customer",
            directCustomerId: (formMode as DirectCustomerSummary).id,
            fields
          });
    if (ok) {
      show({ message: formMode === "create" ? `Direct customer "${fields.name}" added.` : `Direct customer "${fields.name}" saved.` });
      setFormMode(null);
    }
  }

  async function confirmDelete(reason: string) {
    if (!deleteTarget) return;
    const ok = await mutate({ action: "delete_direct_customer", directCustomerId: deleteTarget.id, reason });
    if (ok) {
      show({ message: `Direct customer "${deleteTarget.name}" removed.` });
      setDeleteTarget(null);
    }
  }

  // Cadence is a pair: both set or both empty.
  const cadenceConsistent = (form.cadenceCount.trim() === "") === (form.cadencePeriod === "");
  const formValid = form.name.trim() && cadenceConsistent;

  return (
    <div className="db-ref">
      <div className="db-ref-body">
        <div className="db-ref-head">
          <div>
            <h2 className="db-ref-h">Direct customers</h2>
            <div className="db-ref-desc">
              Guaranteed recurring backhaul freight used to pre-stage trailers.{" "}
              {canWrite ? "Cadence drives how many trailers get staged per day or week." : "Read-only for your role."}
            </div>
          </div>
          <div className="db-ref-actions">
            {canWrite ? (
              <button type="button" className="db-btn primary" disabled={busy} onClick={openCreate}>
                <PlusIcon size={14} /> Add direct customer
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
            <strong>Cadence</strong> is the guaranteed load count — e.g. SEALED AIR 1/day, AB 10/week. Leave it empty for
            customers without a committed volume.
          </span>
        </div>

        {error && !deleteTarget && !formMode ? <p className="db-upload-error">{error}</p> : null}

        {customers.length === 0 ? (
          <EmptyState
            icon={<BoxIcon size={22} />}
            title="No direct customers yet"
            copy={canWrite ? "Add the customers with guaranteed recurring freight for this region." : "No direct customers have been set up for this region yet."}
            action={canWrite ? { label: "Add direct customer", onClick: openCreate } : undefined}
          />
        ) : (
          <div className="db-card-table">
            <table className="db-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th style={{ width: 130 }}>Cadence</th>
                  <th>Notes</th>
                  {canWrite ? <th className="right" style={{ width: 88 }}>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {customers.map((customer, index) => (
                  <tr key={customer.id} className={`db-row${index % 2 ? " odd" : ""}`}>
                    <td>
                      <div className="strong">{customer.name}</div>
                    </td>
                    <td>
                      <CadenceCell customer={customer} />
                    </td>
                    <td>
                      {customer.notes ? <span className="db-subnote">{customer.notes}</span> : <span className="faint">—</span>}
                    </td>
                    {canWrite ? (
                      <td className="actions right">
                        <span className="db-rowbtns">
                          <button type="button" className="db-iconbtn-sm" aria-label="Edit direct customer" title="Edit direct customer" disabled={busy} onClick={() => openEdit(customer)}>
                            <PencilIcon size={15} />
                          </button>
                          <button type="button" className="db-iconbtn-sm danger" aria-label="Remove direct customer" title="Remove direct customer" disabled={busy} onClick={() => setDeleteTarget(customer)}>
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
          eyebrow="Reference · Direct customers"
          title={formMode === "create" ? "Add direct customer" : `Edit ${(formMode as DirectCustomerSummary).name}`}
          busy={busy}
          onClose={() => setFormMode(null)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => setFormMode(null)}>
                Cancel
              </button>
              <button type="button" className="db-btn primary" disabled={busy || !formValid} aria-busy={busy} onClick={() => void submitForm()}>
                {busy ? "Saving…" : formMode === "create" ? "Add direct customer" : "Save direct customer"}
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
            <label className="db-field-label db-form-full">
              Name
              <input className="db-input" value={form.name} maxLength={160} onChange={(event) => setField("name", event.target.value)} required />
            </label>
            <label className="db-field-label">
              Loads
              <input
                className="db-input mono"
                type="number"
                min="1"
                value={form.cadenceCount}
                onChange={(event) => setField("cadenceCount", event.target.value)}
              />
              <span className="db-field-hint">guaranteed count</span>
            </label>
            <label className="db-field-label">
              Per
              <select
                className="db-input"
                value={form.cadencePeriod}
                onChange={(event) => setField("cadencePeriod", event.target.value as CustomerForm["cadencePeriod"])}
              >
                <option value="">— No cadence —</option>
                <option value="DAY">Day</option>
                <option value="WEEK">Week</option>
              </select>
              {!cadenceConsistent ? <span className="db-field-hint">set both a count and a period, or neither</span> : null}
            </label>
            <label className="db-field-label db-form-full">
              Notes
              <textarea className="db-input" value={form.notes} maxLength={500} onChange={(event) => setField("notes", event.target.value)} />
            </label>
            {error ? <p className="db-upload-error db-form-full">{error}</p> : null}
            <button type="submit" hidden />
          </form>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Remove direct customer"
          message={
            <>
              Remove direct customer <strong>{deleteTarget.name}</strong>? Trailer pre-staging will no longer count on
              their cadence.
            </>
          }
          reason={{ label: "Reason for removal", placeholder: "e.g. Contract ended" }}
          destructive
          confirmLabel="Remove direct customer"
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
