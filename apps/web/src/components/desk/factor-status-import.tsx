"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { applyFactorStatusAction, checkFactorStatusAction } from "@/app/(desk)/actions";
import type { ImportResult } from "@/server/partners/factor-status-import";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * A factor's status file, put in by hand (docs/MONEY_PLAN.md, Wave 2): paste it or choose the CSV, check it (nothing is written; each line says what it would do), then apply. Lines that
 * are already true do nothing, so the same file put in twice changes nothing.
 */
const ACTION: Record<"apply" | "already" | "error", { label: string; tone: string }> = {
  apply: { label: "Will apply", tone: "info" },
  already: { label: "Already so", tone: "muted" },
  error: { label: "Not applied", tone: "bad" }
};

export function FactorStatusImport({ canAct }: { canAct: boolean }) {
  const router = useRouter();
  const toast = useToast();
  // A pasted file is kept like any typed field (a chosen file is read into the same box), up to a size a browser keeps comfortably.
  const [f, setF, kept] = useDraft<{ text: string }>("factor-status-file", { text: "" });
  const [result, setResult] = React.useState<(ImportResult & { ok: true }) | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"check" | "apply" | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    if (file.size > 2_000_000) return setMessage("That file is over 2 MB. Split it.");
    setF({ text: await file.text() });
    setResult(null);
    setMessage(null);
  }

  async function run(apply: boolean) {
    setMessage(null);
    if (f.text.trim() === "") return setMessage("Paste the factor's status file, or choose it.");
    setBusy(apply ? "apply" : "check");
    const got = await tried(() => (apply ? applyFactorStatusAction(f.text) : checkFactorStatusAction(f.text)));
    setBusy(null);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (!out.ok) {
      setResult(null);
      return setMessage(out.error);
    }
    setResult(out);
    if (apply) {
      const applied = out.rows.filter((r) => r.action === "apply").length;
      toast({ text: applied > 0 ? `${applied} ${applied === 1 ? "line" : "lines"} applied${out.counts.error > 0 ? `, ${out.counts.error} not` : ""}.` : "Nothing to change: every line was already so or could not be applied.", tone: out.counts.error > 0 ? "bad" : "ok" });
      if (applied > 0) kept.saved();
      router.refresh();
    }
  }

  return (
    <div className="dlg-form">
      <DraftNote draft={kept} what="this file" />
      <label className="tl-field">
        The factor&apos;s status file (CSV)
        <textarea
          rows={6}
          value={f.text}
          maxLength={2_000_000}
          placeholder={"Invoice,Status,Amount,Reason\nINV-1001,Funded,1350.00,\nINV-1002,Chargeback,,Customer did not pay"}
          onChange={(e) => {
            setF({ text: e.target.value });
            setResult(null);
          }}
          disabled={!canAct}
        />
        <span className="th-hint">Columns are found by name: Invoice (or Reference), Status, and if the factor gives them, Amount and Reason. Statuses: funded, rejected, paid, chargeback.</span>
      </label>
      {canAct ? (
        <div className="dlg-foot-row">
          {message ? (
            <span className="tl-note warn" role="alert">
              {message}
            </span>
          ) : null}
          <label className="tl-btn ghost">
            Choose a file
            <input type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => void choose(e.target.files?.[0])} />
          </label>
          <button type="button" className="tl-btn" disabled={busy !== null} onClick={() => void run(false)}>
            {busy === "check" ? "Checking…" : "Check the file"}
          </button>
          <button type="button" className="tl-btn primary" disabled={busy !== null || !result || result.applied || result.counts.apply === 0} onClick={() => void run(true)} title={!result ? "Check the file first" : undefined}>
            {busy === "apply" ? "Applying…" : result && !result.applied ? `Apply ${result.counts.apply} ${result.counts.apply === 1 ? "change" : "changes"}` : "Apply"}
          </button>
        </div>
      ) : (
        <p className="tl-sub">Accounting or Admin puts the factor&apos;s status file in.</p>
      )}
      {result ? (
        <>
          <p className="tl-note">
            {result.applied ? "Applied" : "Checked"} file {result.fingerprint}: {result.counts.apply} {result.applied ? "applied" : "to apply"}, {result.counts.already} already so, {result.counts.error} that cannot be applied.
          </p>
          <table className="tl-table" aria-label="What each line of the file does">
            <thead>
              <tr>
                <th className="num">Line</th>
                <th>Invoice</th>
                <th>The factor says</th>
                <th>What happens</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.line}>
                  <td className="num">{r.line}</td>
                  <td>{r.invoice ?? "—"}</td>
                  <td>{r.statusText || "—"}</td>
                  <td>
                    <span className={`tl-chip ${ACTION[r.action].tone}`}>{result.applied && r.action === "apply" ? "Applied" : ACTION[r.action].label}</span>
                    <span className="sub">{r.detail}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
