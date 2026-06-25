"use client";

import Link from "next/link";
import React from "react";
import type { LaneSummary } from "@/server/reference";
import { ReferenceTabs } from "@/components/reference/reference-tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { UndoToast, useToast } from "@/components/ui/toast";
import { ChevronRightIcon, SparkIcon, LockIcon, PencilIcon, PlusIcon, RouteIcon, TrashIcon } from "@/components/icons";

interface LanesManagerProps {
  initialLanes: LaneSummary[];
  canWrite: boolean;
}

function rate2(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : value;
}

export function LanesManager({ initialLanes, canWrite }: LanesManagerProps) {
  const [lanes, setLanes] = React.useState<LaneSummary[]>(initialLanes);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [showCreate, setShowCreate] = React.useState(false);
  const [originCity, setOriginCity] = React.useState("");
  const [originState, setOriginState] = React.useState("");
  const [destinationCity, setDestinationCity] = React.useState("");
  const [destinationState, setDestinationState] = React.useState("");
  const [targetRate, setTargetRate] = React.useState("");

  const [deleteTarget, setDeleteTarget] = React.useState<LaneSummary | null>(null);
  const [editTarget, setEditTarget] = React.useState<LaneSummary | null>(null);
  const [editRate, setEditRate] = React.useState("");
  const { toast, show, clear } = useToast();

  async function mutate(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/reference/lanes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; lanes?: LaneSummary[] } | null;
      if (!response.ok || !payload?.lanes) {
        throw new Error(payload?.error ?? "Request failed.");
      }
      setLanes(payload.lanes);
      return true;
    } catch (mutateError) {
      setError(mutateError instanceof Error ? mutateError.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setOriginCity("");
    setOriginState("");
    setDestinationCity("");
    setDestinationState("");
    setTargetRate("");
    setError(null);
    setShowCreate(true);
  }

  async function submitCreate() {
    const ok = await mutate({
      action: "create_lane",
      lane: {
        originCity: originCity.trim(),
        originState: originState.trim(),
        destinationCity: destinationCity.trim(),
        destinationState: destinationState.trim(),
        targetRate: targetRate.trim()
      }
    });
    if (ok) {
      show({ message: `Lane ${originCity.trim()}, ${originState.trim()} → ${destinationCity.trim()}, ${destinationState.trim()} added.` });
      setShowCreate(false);
    }
  }

  function openSetTarget(lane: LaneSummary) {
    setEditTarget(lane);
    setEditRate(lane.targetRate);
    setError(null);
  }

  async function confirmSetTarget() {
    if (!editTarget || !editRate.trim()) return;
    const ok = await mutate({ action: "set_lane_target", laneId: editTarget.id, targetRate: editRate.trim() });
    if (ok) {
      show({ message: `Target updated for ${editTarget.originCity} → ${editTarget.destinationCity}.` });
      setEditTarget(null);
    }
  }

  async function confirmDelete(reason: string) {
    if (!deleteTarget) return;
    const ok = await mutate({ action: "delete_lane", laneId: deleteTarget.id, reason });
    if (ok) {
      show({ message: `Lane ${deleteTarget.originCity} → ${deleteTarget.destinationCity} removed.` });
      setDeleteTarget(null);
    }
  }

  const createValid =
    originCity.trim() && originState.trim() && destinationCity.trim() && destinationState.trim() && targetRate.trim();

  return (
    <div className="db-ref">
      <ReferenceTabs />
      <div className="db-ref-body">
        <div className="db-ref-head">
          <div>
            <h2 className="db-ref-h">Lanes</h2>
            <div className="db-ref-desc">
              Target rates-per-mile for this region. {canWrite ? "Create lanes and adjust their targets." : "Read-only for your role."}
            </div>
          </div>
          <div className="db-ref-actions">
            {canWrite ? (
              <button type="button" className="db-btn primary" disabled={busy} onClick={openCreate}>
                <PlusIcon size={14} /> Add lane
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
          <SparkIcon size={15} />
          <span>
            Lane targets drive the <strong>vs-target</strong> column on the KPI lane scorecard.
          </span>
          <span className="reco">Recommendation</span>
          <span>show each lane&apos;s trailing NBY ($/mi) here (not in the current schema).</span>
        </div>

        {error && !deleteTarget && !editTarget && !showCreate ? <p className="db-upload-error">{error}</p> : null}

        {lanes.length === 0 ? (
          <EmptyState
            icon={<RouteIcon size={22} />}
            title="No lanes yet"
            copy={canWrite ? "Add a lane to start tracking a target rate-per-mile for this region." : "No lanes have been set up for this region yet."}
            action={canWrite ? { label: "Add lane", onClick: openCreate } : undefined}
          />
        ) : (
          <div className="db-card-table">
            <table className="db-table">
              <thead>
                <tr>
                  <th style={{ width: 220 }}>Origin</th>
                  <th>Destination</th>
                  <th className="right" style={{ width: 150 }}>Target $/mi</th>
                  {canWrite ? <th className="right" style={{ width: 88 }}>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {lanes.map((lane, index) => (
                  <tr key={lane.id} className={`db-row${index % 2 ? " odd" : ""}`}>
                    <td>
                      <span className="db-od">
                        <span className="pt strong">{lane.originCity}</span>
                        <span className="st">{lane.originState}</span>
                      </span>
                    </td>
                    <td>
                      <span className="db-od">
                        <span className="ar"><ChevronRightIcon size={13} /></span>
                        <span className="pt">{lane.destinationCity}</span>
                        <span className="st">{lane.destinationState}</span>
                      </span>
                    </td>
                    <td className="mono num right strong">
                      {rate2(lane.targetRate)}
                      <span className="db-cap-unit"> /mi</span>
                    </td>
                    {canWrite ? (
                      <td className="actions right">
                        <span className="db-rowbtns">
                          <button type="button" className="db-iconbtn-sm" title="Set target rate" disabled={busy} onClick={() => openSetTarget(lane)}>
                            <PencilIcon size={15} />
                          </button>
                          <button type="button" className="db-iconbtn-sm danger" title="Remove lane" disabled={busy} onClick={() => setDeleteTarget(lane)}>
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
          eyebrow="Reference · Lanes"
          title="Add lane"
          busy={busy}
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button type="button" className="db-btn primary" disabled={busy || !createValid} aria-busy={busy} onClick={() => void submitCreate()}>
                {busy ? "Saving…" : "Add lane"}
              </button>
            </>
          }
        >
          <form
            className="db-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              if (createValid) void submitCreate();
            }}
          >
            <label className="db-field-label">
              Origin city
              <input className="db-input" value={originCity} onChange={(event) => setOriginCity(event.target.value)} required />
            </label>
            <label className="db-field-label">
              Origin state
              <input className="db-input" value={originState} maxLength={2} onChange={(event) => setOriginState(event.target.value)} required />
            </label>
            <label className="db-field-label">
              Destination city
              <input className="db-input" value={destinationCity} onChange={(event) => setDestinationCity(event.target.value)} required />
            </label>
            <label className="db-field-label">
              Destination state
              <input className="db-input" value={destinationState} maxLength={2} onChange={(event) => setDestinationState(event.target.value)} required />
            </label>
            <label className="db-field-label db-form-full">
              Target rate
              <div className="db-prefix-input">
                <span className="pfx">$</span>
                <input className="db-input mono" type="number" step="0.0001" min="0" value={targetRate} onChange={(event) => setTargetRate(event.target.value)} required />
              </div>
              <span className="db-field-hint">Rate-per-mile target. Feeds the lane scorecard on the KPI dashboard.</span>
            </label>
            {error ? <p className="db-upload-error db-form-full">{error}</p> : null}
            <button type="submit" hidden />
          </form>
        </Modal>
      ) : null}

      {editTarget ? (
        <Modal
          eyebrow={`${editTarget.originCity}, ${editTarget.originState} → ${editTarget.destinationCity}, ${editTarget.destinationState}`}
          title="Set target rate"
          busy={busy}
          onClose={() => setEditTarget(null)}
          footer={
            <>
              <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => setEditTarget(null)}>
                Cancel
              </button>
              <button type="button" className="db-btn primary" disabled={busy || !editRate.trim()} aria-busy={busy} onClick={() => void confirmSetTarget()}>
                {busy ? "Saving…" : "Save target"}
              </button>
            </>
          }
        >
          <label className="db-field-label">
            Target rate
            <div className="db-prefix-input">
              <span className="pfx">$</span>
              <input
                className="db-input mono"
                type="number"
                step="0.0001"
                min="0"
                value={editRate}
                disabled={busy}
                onChange={(event) => setEditRate(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void confirmSetTarget();
                  }
                }}
              />
            </div>
            <span className="db-field-hint">Current target {rate2(editTarget.targetRate)} /mi.</span>
          </label>
          {error ? (
            <p className="db-upload-error" role="status" aria-live="polite">
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Remove lane"
          message={
            <>
              Remove lane <strong>{deleteTarget.originCity}, {deleteTarget.originState} → {deleteTarget.destinationCity}, {deleteTarget.destinationState}</strong>? It will stop appearing in pickers and the scorecard. This can be reviewed later in the audit trail.
            </>
          }
          reason={{ label: "Reason for removal", placeholder: "e.g. Lane no longer serviced" }}
          destructive
          confirmLabel="Remove lane"
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
