"use client";

import Link from "next/link";
import React from "react";
import type { BrokerSummary } from "@/server/reference";
import { ReferenceTabs } from "@/components/reference/reference-tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Toggle } from "@/components/ui/toggle";
import { UndoToast, useToast } from "@/components/ui/toast";
import { BuildingIcon, CheckIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon, WarningIcon } from "@/components/icons";

type OnboardingStatus = "PENDING" | "APPROVED" | "BLOCKED";
const STATUSES: OnboardingStatus[] = ["PENDING", "APPROVED", "BLOCKED"];
const STATUS_VARIANT: Record<OnboardingStatus, "ok" | "near" | "below"> = {
  APPROVED: "ok",
  PENDING: "near",
  BLOCKED: "below"
};

function RefStatus({ status }: { status: OnboardingStatus }) {
  return <span className={`db-lane-status ${STATUS_VARIANT[status]} mono`}>{status}</span>;
}

interface BrokersManagerProps {
  initialBrokers: BrokerSummary[];
  canWrite: boolean;
}

export function BrokersManager({ initialBrokers, canWrite }: BrokersManagerProps) {
  const [brokers, setBrokers] = React.useState<BrokerSummary[]>(initialBrokers);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<BrokerSummary | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast, show, clear } = useToast();

  const [newName, setNewName] = React.useState("");
  const [newStatus, setNewStatus] = React.useState<OnboardingStatus>("PENDING");
  const [newFsc, setNewFsc] = React.useState(true);

  const selected = brokers.find((b) => b.id === selectedId) ?? null;

  async function mutate(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/reference/brokers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; brokers?: BrokerSummary[] } | null;
      if (!response.ok || !payload?.brokers) {
        throw new Error(payload?.error ?? "Request failed.");
      }
      setBrokers(payload.brokers);
      return true;
    } catch (mutateError) {
      setError(mutateError instanceof Error ? mutateError.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setNewName("");
    setNewStatus("PENDING");
    setNewFsc(true);
    setError(null);
    setShowCreate(true);
  }

  async function submitCreate() {
    const name = newName.trim();
    if (!name) {
      setError("A broker name is required.");
      return;
    }
    const ok = await mutate({ action: "create_broker", broker: { name, onboardingStatus: newStatus, fscDefaultApplies: newFsc } });
    if (ok) {
      show({ message: `Broker "${name}" added.` });
      setShowCreate(false);
    }
  }

  async function confirmDeleteBroker(reason: string) {
    if (!deleteTarget) return;
    const ok = await mutate({ action: "delete_broker", brokerId: deleteTarget.id, reason });
    if (ok) {
      if (selectedId === deleteTarget.id) setSelectedId(null);
      show({ message: `Broker "${deleteTarget.name}" removed.` });
      setDeleteTarget(null);
    }
  }

  return (
    <div className="db-ref">
      <ReferenceTabs />
      <div className="db-ref-body">
        <div className="db-ref-head">
          <div>
            <h2 className="db-ref-h">Brokers</h2>
            <div className="db-ref-desc">
              Brokers loads are booked against in this region. {canWrite ? "Manage brokers, onboarding status, and their contacts." : "Read-only for your role."}
            </div>
          </div>
          <div className="db-ref-actions">
            {canWrite ? (
              <button type="button" className="db-btn primary" disabled={busy} onClick={openCreate}>
                <PlusIcon size={14} /> Add broker
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

        {error && !deleteTarget && !selectedId && !showCreate ? <p className="db-upload-error">{error}</p> : null}

        {brokers.length === 0 ? (
          <EmptyState
            icon={<BuildingIcon size={22} />}
            title="No brokers yet"
            copy={canWrite ? "Add a broker to start booking loads against it in this region." : "No brokers have been set up for this region yet."}
            action={canWrite ? { label: "Add broker", onClick: openCreate } : undefined}
          />
        ) : (
          <div className="db-card-table">
            <table className="db-table">
              <thead>
                <tr>
                  <th>Broker</th>
                  <th style={{ width: 150 }}>Onboarding</th>
                  <th style={{ width: 170 }}>Fuel surcharge</th>
                  <th style={{ width: 130 }}>Contacts</th>
                  {canWrite ? <th className="right" style={{ width: 88 }}>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {brokers.map((broker, index) => (
                  <tr key={broker.id} className={`db-row${index % 2 ? " odd" : ""}`}>
                    <td className="strong">{broker.name}</td>
                    <td><RefStatus status={broker.onboardingStatus} /></td>
                    <td>
                      {broker.fscDefaultApplies ? (
                        <span className="db-flag muted">FSC default</span>
                      ) : (
                        <span className="db-flag warn"><WarningIcon size={12} /> FSC off</span>
                      )}
                    </td>
                    <td className="dim">
                      {broker.reps.length ? `${broker.reps.length} contact${broker.reps.length > 1 ? "s" : ""}` : <span className="faint">—</span>}
                    </td>
                    {canWrite ? (
                      <td className="actions right">
                        <span className="db-rowbtns">
                          <button type="button" className="db-iconbtn-sm" title="Edit broker" disabled={busy} onClick={() => setSelectedId(broker.id)}>
                            <PencilIcon size={15} />
                          </button>
                          <button type="button" className="db-iconbtn-sm danger" title="Remove broker" disabled={busy} onClick={() => setDeleteTarget(broker)}>
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

      {showCreate ? (
        <Modal
          eyebrow="Reference · Brokers"
          title="Add broker"
          busy={busy}
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button type="button" className="db-btn primary" disabled={busy || !newName.trim()} aria-busy={busy} onClick={() => void submitCreate()}>
                {busy ? "Saving…" : "Add broker"}
              </button>
            </>
          }
        >
          <form
            className="db-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
          >
            <label className="db-field-label db-form-full">
              Broker name
              <input className="db-input" value={newName} placeholder="e.g. Acme Logistics" onChange={(event) => setNewName(event.target.value)} />
            </label>
            <label className="db-field-label">
              Onboarding status
              <select className="db-input" value={newStatus} onChange={(event) => setNewStatus(event.target.value as OnboardingStatus)}>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
            <div className="db-field-label">
              FSC default
              <div style={{ paddingTop: 6 }}>
                <Toggle on={newFsc} onChange={setNewFsc} label={newFsc ? "Applies by default" : "Off — quote fuel manually"} disabled={busy} />
              </div>
            </div>
            {error ? <p className="db-upload-error db-form-full">{error}</p> : null}
            <button type="submit" hidden />
          </form>
        </Modal>
      ) : null}

      {selected ? (
        <Modal
          eyebrow="Reference · Brokers"
          title={`Edit ${selected.name}`}
          ariaLabel={`Edit broker ${selected.name}`}
          width="wide"
          busy={busy}
          onClose={() => setSelectedId(null)}
          footer={
            <>
              <button
                type="button"
                className="db-btn db-btn-ghost"
                style={{ marginRight: "auto", color: "var(--db-neg)" }}
                disabled={busy}
                onClick={() => {
                  setDeleteTarget(selected);
                  setSelectedId(null);
                }}
              >
                <TrashIcon size={14} /> Remove broker
              </button>
              <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => setSelectedId(null)}>
                Close
              </button>
            </>
          }
        >
          <BrokerEditor key={selected.id} broker={selected} busy={busy} mutate={mutate} onDone={show} />
        </Modal>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Remove broker"
          message={
            <>
              Remove broker <strong>{deleteTarget.name}</strong>? This can be reviewed later in the audit trail.
            </>
          }
          reason={{ label: "Reason for removal", placeholder: "e.g. No longer a partner" }}
          destructive
          confirmLabel="Remove broker"
          busyLabel="Removing…"
          busy={busy}
          error={error}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={(reason) => void confirmDeleteBroker(reason)}
        />
      ) : null}

      <UndoToast toast={toast} onDismiss={clear} />
    </div>
  );
}

interface BrokerEditorProps {
  broker: BrokerSummary;
  busy: boolean;
  mutate: (body: Record<string, unknown>) => Promise<boolean>;
  onDone: (toast: { message: string }) => void;
}

function BrokerEditor({ broker, busy, mutate, onDone }: BrokerEditorProps) {
  const [name, setName] = React.useState(broker.name);
  const [status, setStatus] = React.useState<OnboardingStatus>(broker.onboardingStatus);
  const [fsc, setFsc] = React.useState(broker.fscDefaultApplies);
  const [repName, setRepName] = React.useState("");
  const [repEmail, setRepEmail] = React.useState("");
  const [repPhone, setRepPhone] = React.useState("");
  const repNameInputRef = React.useRef<HTMLInputElement | null>(null);

  const dirty = name.trim() !== broker.name || status !== broker.onboardingStatus || fsc !== broker.fscDefaultApplies;

  async function onSaveBroker() {
    const fields: Record<string, unknown> = {};
    if (name.trim() && name.trim() !== broker.name) fields.name = name.trim();
    if (status !== broker.onboardingStatus) fields.onboardingStatus = status;
    if (fsc !== broker.fscDefaultApplies) fields.fscDefaultApplies = fsc;
    if (Object.keys(fields).length === 0) return;
    const ok = await mutate({ action: "update_broker", brokerId: broker.id, fields });
    if (ok) onDone({ message: "Broker updated." });
  }

  async function onAddRep() {
    if (!repName.trim()) return;
    const ok = await mutate({
      action: "add_rep",
      brokerId: broker.id,
      rep: { name: repName.trim(), email: repEmail.trim() || undefined, phone: repPhone.trim() || undefined }
    });
    if (ok) {
      setRepName("");
      setRepEmail("");
      setRepPhone("");
      onDone({ message: "Contact added." });
    }
  }

  async function onDeleteRep(repId: string) {
    const ok = await mutate({ action: "delete_rep", brokerId: broker.id, repId });
    if (ok) onDone({ message: "Contact removed." });
  }

  return (
    <div>
      <div className="db-form-grid">
        <label className="db-field-label db-form-full">
          Broker name
          <input className="db-input" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="db-field-label">
          Onboarding status
          <select className="db-input" value={status} onChange={(event) => setStatus(event.target.value as OnboardingStatus)}>
            {STATUSES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <div className="db-field-label">
          FSC default
          <div style={{ paddingTop: 6 }}>
            <Toggle on={fsc} onChange={setFsc} label={fsc ? "Applies by default" : "Off — quote fuel manually"} disabled={busy} />
          </div>
        </div>
        <div className="db-form-full" style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="db-btn primary" disabled={busy || !dirty} onClick={() => void onSaveBroker()}>
            {busy ? "Saving…" : "Save broker"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "18px 0 8px" }}>
        <h3 className="db-set-eyebrow" style={{ margin: 0 }}>Contacts · {broker.reps.length}</h3>
        <button type="button" className="db-btn db-btn-mini" onClick={() => repNameInputRef.current?.focus()}>
          <PlusIcon size={13} /> Add contact
        </button>
      </div>
      <div className="db-card-table">
        <table className="db-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th className="right" style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {broker.reps.map((rep) => (
              <tr key={rep.id} className="db-row">
                <td className="strong">{rep.name}</td>
                <td className="mono dim">{rep.email ?? "—"}</td>
                <td className="mono dim">{rep.phone ?? "—"}</td>
                <td className="right">
                  <button type="button" className="db-iconbtn-sm danger" title="Remove contact" disabled={busy} onClick={() => void onDeleteRep(rep.id)}>
                    <TrashIcon size={15} />
                  </button>
                </td>
              </tr>
            ))}
            <tr className="db-row">
              <td><input ref={repNameInputRef} className="db-input" placeholder="Add name…" value={repName} onChange={(event) => setRepName(event.target.value)} /></td>
              <td><input className="db-input" type="email" placeholder="email (optional)" value={repEmail} onChange={(event) => setRepEmail(event.target.value)} /></td>
              <td><input className="db-input" placeholder="phone (optional)" value={repPhone} onChange={(event) => setRepPhone(event.target.value)} /></td>
              <td className="right">
                <button type="button" className="db-iconbtn-sm" title="Save contact" disabled={busy || !repName.trim()} onClick={() => void onAddRep()}>
                  <CheckIcon size={15} />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
