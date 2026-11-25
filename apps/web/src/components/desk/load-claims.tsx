"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { createLoadClaimAction, removeLoadClaimAction, updateLoadClaimAction } from "@/app/(desk)/actions";
import { CLAIM_STATUS_LABEL, CLAIM_STATUSES, CLAIM_TYPE_LABEL, CLAIM_TYPES, type ClaimStatus, type ClaimType } from "@/lib/claims";
import { shortDate, usd } from "@/lib/desk-format";
import { DateInput } from "./date-input";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";
import { DraftNote, useDraft } from "./kit/use-draft";

export type ClaimViewItem = {
  id: string;
  type: ClaimType;
  status: ClaimStatus;
  pieces: number | null;
  amount: number | null;
  claimant: string | null;
  externalNumber: string | null;
  openedAt: string;
  ackBy: string;
  decideBy: string;
  note: string | null;
};

type ClaimDraft = {
  type: ClaimType;
  pieces: string;
  amount: string;
  claimant: string;
  externalNumber: string;
  openedAt: string;
  note: string;
};

const TONE: Record<ClaimStatus, string> = {
  open: "warn",
  acknowledged: "info",
  settled: "ok",
  denied: "bad",
  closed: "muted"
};

/**
 * OS&D claims (overage, shortage, damage, refused freight) on the load drawer Paperwork tab,
 * tracked against 49 CFR Part 370 deadlines (+30d acknowledgment, +120d decision).
 */
export function LoadClaims({
  loadId,
  defaultClaimant,
  items,
  invoiced,
  canEdit,
  canRemove,
  canWriteOff
}: {
  loadId: string;
  defaultClaimant: string | null;
  items: ClaimViewItem[];
  invoiced: boolean;
  canEdit: boolean;
  canRemove: boolean;
  canWriteOff: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [form, setForm, draft] = useDraft<ClaimDraft>(`claim-new:${loadId}`, {
    type: "damage",
    pieces: "",
    amount: "",
    claimant: defaultClaimant ?? "",
    externalNumber: "",
    openedAt: today,
    note: ""
  });

  async function addClaim(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const got = await tried(() =>
      createLoadClaimAction(loadId, {
        type: form.type,
        pieces: form.pieces,
        amount: form.amount,
        claimant: form.claimant,
        externalNumber: form.externalNumber,
        openedAt: form.openedAt,
        note: form.note
      })
    );
    setBusy(false);
    if (!got.ok) return setError(got.message);
    if (!got.value.ok) return setError(got.value.error);
    draft.discard();
    setOpen(false);
    toast({ text: "OS&D claim recorded.", tone: "ok" });
    router.refresh();
  }

  async function changeStatus(id: string, status: ClaimStatus) {
    setBusy(true);
    const got = await tried(() => updateLoadClaimAction(id, { status }));
    setBusy(false);
    if (!got.ok) return toast({ text: got.message, tone: "bad" });
    if (!got.value.ok) return toast({ text: got.value.error, tone: "bad" });
    toast({ text: `Claim marked ${CLAIM_STATUS_LABEL[status].toLowerCase()}.`, tone: "ok" });
    router.refresh();
  }

  async function removeClaim(id: string) {
    setBusy(true);
    const got = await tried(() => removeLoadClaimAction(id));
    setBusy(false);
    if (!got.ok) return toast({ text: got.message, tone: "bad" });
    if (!got.value.ok) return toast({ text: got.value.error, tone: "bad" });
    toast({ text: "Claim removed.", tone: "ok" });
    router.refresh();
  }

  return (
    <div>
      {items.length === 0 ? (
        <p className="tl-note" style={{ margin: "0 0 8px" }}>
          No OS&amp;D claims on this load. Upload exception photos as <b>OS&amp;D photo</b> under Documents above (kept on the desk, not sent to the driver).
        </p>
      ) : (
        <ul className="feed" style={{ marginBottom: 10 }}>
          {items.map((c) => (
            <li key={c.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>
                  <span className="tl-chip muted" style={{ marginRight: 6 }}>{CLAIM_TYPE_LABEL[c.type] ?? c.type}</span>
                  <span className={`tl-chip ${TONE[c.status] ?? "muted"}`}>{CLAIM_STATUS_LABEL[c.status] ?? c.status}</span>
                  {c.amount != null ? <b style={{ marginLeft: 8 }}>{usd(c.amount, 2)}</b> : null}
                  {c.pieces != null ? ` · ${c.pieces} pcs` : ""}
                  {c.claimant ? ` · ${c.claimant}` : ""}
                  {c.externalNumber ? ` · #${c.externalNumber}` : ""}
                </span>
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  {canEdit ? (
                    <select
                      aria-label={`Status for claim ${c.externalNumber ?? CLAIM_TYPE_LABEL[c.type]}`}
                      value={c.status}
                      disabled={busy}
                      onChange={(e) => void changeStatus(c.id, e.target.value as ClaimStatus)}>
                      {CLAIM_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {CLAIM_STATUS_LABEL[st]}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {canRemove ? (
                    <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => void removeClaim(c.id)}>
                      Remove
                    </button>
                  ) : null}
                </span>
              </div>
              <div className="t">
                Opened {shortDate(new Date(c.openedAt))} · Ack by {shortDate(new Date(c.ackBy))} (+30d) · Decide by {shortDate(new Date(c.decideBy))} (+120d, 49 CFR Part 370)
              </div>
              {c.note ? <div className="r">“{c.note}”</div> : null}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {canEdit ? (
          <button type="button" className="tl-btn sm" onClick={() => setOpen((x) => !x)}>
            {open ? "Close claim form" : "Record OS&D claim"}
          </button>
        ) : null}
        {invoiced && canWriteOff ? (
          <Link className="tl-btn ghost sm" href={`/invoices/${loadId}?writeoff=damage_claim`}>
            Write off short pay (damage_claim)
          </Link>
        ) : (
          <span className="tl-sub">Short-pay write-off code: <code>damage_claim</code></span>
        )}
      </div>

      {open && canEdit ? (
        <form onSubmit={(e) => void addClaim(e)} style={{ marginTop: 10 }}>
          <DraftNote draft={draft} what="this OS&D claim" />
          <div className="rc-grid">
            <label className="tl-field">
              Claim type
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ClaimType })}>
                {CLAIM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CLAIM_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="tl-field">
              Amount ($)
              <input inputMode="decimal" placeholder="0.00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </label>
            <label className="tl-field">
              Pieces
              <input inputMode="numeric" value={form.pieces} onChange={(e) => setForm({ ...form, pieces: e.target.value })} />
            </label>
            <label className="tl-field">
              Claimant
              <input maxLength={120} value={form.claimant} onChange={(e) => setForm({ ...form, claimant: e.target.value })} />
            </label>
            <label className="tl-field">
              External claim #
              <input maxLength={60} value={form.externalNumber} onChange={(e) => setForm({ ...form, externalNumber: e.target.value })} />
            </label>
            <label className="tl-field">
              Opened date
              <DateInput type="date" value={form.openedAt} onChange={(e) => setForm({ ...form, openedAt: e.target.value })} />
            </label>
          </div>
          <label className="tl-field" style={{ marginTop: 8 }}>
            Note
            <textarea maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="What happened at the dock (pallets short, damaged carton, OS&D ref)..." />
          </label>
          {error ? (
            <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
              {error}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="submit" className="tl-btn primary sm" disabled={busy}>
              Save claim
            </button>
            <span className="tl-sub">Sets +30 day ack and +120 day decision deadlines per 49 CFR Part 370.</span>
          </div>
        </form>
      ) : null}
    </div>
  );
}
