"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/(desk)/actions";
import { API_SCOPES, LABEL_MAX, SCOPE_LABEL, type ApiScope } from "@/lib/api-keys";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * Settings, Integrations: keys for the partner read API (docs/MONEY_PLAN.md, Wave 7 step 2). Admins make a key with a name and what it may read; the whole key is shown once, here, and only
 * held in this component's memory until "Done" (never in the draft store or the page). Revoking asks twice. Everyone else does not see this card.
 */
export type ApiKeyView = { id: string; label: string; masked: string; scopes: ApiScope[]; createdBy: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; revokedBy: string | null };
type Draft = { label: string; scopes: ApiScope[] };
const BLANK: Draft = { label: "", scopes: [] };

export function ApiKeysCard({ rows, canEdit, planRefusal, origin }: { rows: ApiKeyView[]; canEdit: boolean; planRefusal: string | null; origin: string }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF, kept] = useDraft<Draft>("api-key-new", BLANK);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [made, setMade] = React.useState<{ key: string; masked: string } | null>(null);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const inUse = rows.filter((r) => !r.revokedAt);

  async function create() {
    setMessage(null);
    setBusy(true);
    const got = await tried(() => createApiKeyAction(f.label, f.scopes));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    if (!got.value.ok) return setMessage(got.value.error);
    kept.saved();
    setF(BLANK);
    setMade({ key: got.value.key, masked: got.value.masked });
    router.refresh();
  }

  async function revoke(id: string) {
    if (confirming !== id) return setConfirming(id);
    setConfirming(null);
    setBusy(true);
    const got = await tried(() => revokeApiKeyAction(id));
    setBusy(false);
    if (!got.ok) return toast({ text: got.message, tone: "bad" });
    if (!got.value.ok) return toast({ text: got.value.error, tone: "bad" });
    toast({ text: got.value.changed ? "Key revoked. It is refused from the next request on." : "That key was already revoked.", tone: "ok" });
    router.refresh();
  }

  async function copy(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      toast({ text: "Key copied.", tone: "ok" });
    } catch {
      toast({ text: "This browser would not copy it: select the key and copy it by hand.", tone: "bad" });
    }
  }

  const toggle = (s: ApiScope) => setF({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] });

  return (
    <div className="ak-card">
      <p className="tl-note dlg-lead">
        A partner system (an accounting tool, a factor, the fleet&apos;s own reports) reads this fleet&apos;s invoices, payments, driver statements and loads with a key. Each key reads only what is
        ticked when it is made, and only this fleet. Drivers are named by id, never by name or contact details. At most 60 requests a minute per key.
      </p>
      <p className="tl-sub ak-usage">
        <code>GET {origin || ""}/api/v1/invoices</code> with <code>Authorization: Bearer tlk_…</code>
      </p>

      {made ? (
        <div className="ak-made" role="status">
          <p className="ak-made-lead">
            <b>Copy this key now.</b> It is shown once: TrueLane keeps only a fingerprint of it, so it cannot be shown again. Lost, it is revoked and a new one made.
          </p>
          <div className="ak-made-row">
            <input className="ak-secret" readOnly value={made.key} aria-label={`The new key ${made.masked}`} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="tl-btn sm" onClick={() => void copy(made.key)}>
              Copy
            </button>
            <button type="button" className="tl-btn primary sm" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <table className="tl-table ak-table" aria-label="API keys">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Reads</th>
              <th>Made</th>
              <th>Last used</th>
              <th>State</th>
              {canEdit ? <th aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} aria-disabled={r.revokedAt ? "true" : undefined}>
                <td>
                  <b>{r.label}</b>
                </td>
                <td>
                  <code>{r.masked}</code>
                </td>
                <td>{r.scopes.map((s) => SCOPE_LABEL[s]).join(", ")}</td>
                <td>
                  {r.createdAt}
                  {r.createdBy ? <span className="tl-sub"> · {r.createdBy}</span> : null}
                </td>
                <td>{r.lastUsedAt ?? "Never"}</td>
                <td>{r.revokedAt ? <span className="tl-chip">Revoked {r.revokedAt}</span> : <span className="tl-chip ok">In use</span>}</td>
                {canEdit ? (
                  <td className="ak-act">
                    {!r.revokedAt ? (
                      <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => void revoke(r.id)}>
                        {confirming === r.id ? "Confirm revoke" : "Revoke"}
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="tl-sub">No keys yet.</p>
      )}

      {planRefusal ? (
        <p className="tl-note warn ak-plan">{planRefusal}</p>
      ) : canEdit ? (
        <form
          className="dlg-form ak-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void create();
          }}>
          <DraftNote draft={kept} what="this key's name" />
          <label className="tl-field">
            Name
            <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={LABEL_MAX} autoComplete="off" disabled={busy} />
            <span className="th-hint">Who or what uses it, like &ldquo;QuickBooks reports&rdquo; or &ldquo;Apex Factoring&rdquo;.</span>
          </label>
          <fieldset className="ak-scopes">
            <legend>May read</legend>
            {API_SCOPES.map((s) => (
              <label key={s} className="ak-scope">
                <input type="checkbox" checked={f.scopes.includes(s)} onChange={() => toggle(s)} disabled={busy} /> {SCOPE_LABEL[s]}
              </label>
            ))}
          </fieldset>
          <div className="dlg-foot-row">
            {message ? (
              <span className="tl-note warn" role="alert">
                {message}
              </span>
            ) : null}
            <span className="tl-sub">{inUse.length} in use</span>
            <button type="submit" className="tl-btn primary" disabled={busy}>
              {busy ? "Making…" : "Make a key"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
