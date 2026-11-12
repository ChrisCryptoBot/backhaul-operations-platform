"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { cancelFactoringBatchAction, retryFactoringBatchAction, sendFactoringBatchAction } from "@/app/(desk)/actions";
import { dayYear, usd } from "@/lib/desk-format";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * Factoring by batch on the Invoices screen (docs/MONEY_PLAN.md, Wave 2): what is ready to go, the button that sends it as one batch (a schedule of accounts and a packet per invoice) by
 * the SFTP or email the factoring terms name, and the recent batches with what happened to each. A batch that did not reach the factor can be tried again or cancelled, which gives its
 * invoices back.
 */
export type BatchRow = {
  id: string;
  number: string;
  status: "queued" | "sent" | "failed" | "cancelled";
  method: string;
  destination: string;
  invoiceCount: number;
  invoiceNumbers: string[];
  total: number;
  bytes: number;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
};

const STATUS: Record<BatchRow["status"], { label: string; tone: string }> = {
  queued: { label: "Sending", tone: "info" },
  sent: { label: "Sent", tone: "ok" },
  failed: { label: "Did not arrive", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" }
};

export function FactoringBatches({ method, destination, ready, held, batches, canAct }: { method: "sftp" | "email"; destination: string; ready: number; held: Array<{ number: string; lacks: string }>; batches: BatchRow[]; canAct: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const via = method === "email" ? "email" : "SFTP";

  async function send() {
    setMessage(null);
    setBusy("send");
    const got = await tried(() => sendFactoringBatchAction());
    setBusy(null);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (!out.ok) return setMessage(out.error);
    toast(
      out.status === "sent"
        ? { text: `${out.number} sent by ${via}: ${out.invoices} ${out.invoices === 1 ? "invoice" : "invoices"}, ${usd(out.total, 2)}${out.leftOver > 0 ? `. ${out.leftOver} more wait for the next batch (an email holds about 18 MB).` : "."}`, tone: "ok" }
        : { text: `${out.number} did not reach the factor: ${out.error ?? "no answer"}. Try it again below.`, tone: "bad" }
    );
    router.refresh();
  }

  async function retry(b: BatchRow) {
    setMessage(null);
    setBusy(b.id);
    const got = await tried(() => retryFactoringBatchAction(b.id));
    setBusy(null);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (!out.ok) return setMessage(out.error);
    toast(out.status === "sent" ? { text: `${b.number} sent.`, tone: "ok" } : { text: `${b.number} still did not arrive: ${out.error ?? "no answer"}.`, tone: "bad" });
    router.refresh();
  }

  return (
    <>
      <p className="tl-note">
        This fleet&apos;s factor takes invoices as a batch of files by {via}, to <b>{destination}</b>. A batch carries a schedule of accounts and one PDF packet per invoice (the invoice, each rate
        confirmation and proof of delivery).
      </p>
      <div className="dlg-foot-row">
        {message ? (
          <span className="tl-note warn" role="alert">
            {message}
          </span>
        ) : null}
        <span className="tl-sub">
          {ready} {ready === 1 ? "invoice is" : "invoices are"} ready{held.length > 0 ? `; ${held.length} waiting for documents` : ""}.
        </span>
        {canAct ? (
          <button type="button" className="tl-btn primary" disabled={busy !== null || ready === 0} onClick={() => void send()}>
            {busy === "send" ? "Sending…" : "Send the ready invoices to the factor"}
          </button>
        ) : null}
      </div>
      {held.length > 0 ? (
        <details className="tl-sub">
          <summary>Waiting for documents</summary>
          <ul>
            {held.map((h) => (
              <li key={h.number}>
                {h.number}: {h.lacks}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {batches.length > 0 ? (
        <table className="tl-table" aria-label="Factoring batches">
          <thead>
            <tr>
              <th>Batch</th>
              <th>Where it stands</th>
              <th className="num">Invoices</th>
              <th className="num">Total</th>
              <th className="num">Tries</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>
                  <b>{b.number}</b>
                  <span className="sub">{dayYear(new Date(b.sentAt ?? b.createdAt))} · {b.method === "email" ? "email" : "SFTP"}</span>
                </td>
                <td>
                  <span className={`tl-chip ${STATUS[b.status].tone}`}>{STATUS[b.status].label}</span>
                  {b.lastError && b.status !== "sent" ? <span className="sub">{b.lastError}</span> : null}
                </td>
                <td className="num">
                  {b.invoiceCount}
                  <span className="sub">{b.invoiceNumbers.slice(0, 3).join(", ")}{b.invoiceNumbers.length > 3 ? ` +${b.invoiceNumbers.length - 3}` : ""}</span>
                </td>
                <td className="num">{usd(b.total, 2)}</td>
                <td className="num">{b.attempts}</td>
                <td className="num">
                  {canAct && b.status === "failed" ? (
                    <span className="tl-form-row">
                      <button type="button" className="tl-btn sm" disabled={busy !== null} onClick={() => void retry(b)}>
                        {busy === b.id ? "Sending…" : "Try again"}
                      </button>
                      <CancelBatch batch={b} />
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function CancelBatch({ batch }: { batch: BatchRow }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [f, setF, kept] = useDraft<{ reason: string }>(`batch-cancel:${batch.id}`, { reason: "" });
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  async function go() {
    setMessage(null);
    if (f.reason.trim().length < 3) return setMessage("Say why the batch is cancelled.");
    setBusy(true);
    const got = await tried(() => cancelFactoringBatchAction(batch.id, f.reason));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    if (got.value.ok) {
      kept.saved();
      setOpen(false);
      toast({ text: `${batch.number} cancelled. Its invoices are no longer with a factor.`, tone: "ok" });
      router.refresh();
    } else setMessage(got.value.error ?? "That batch could not be cancelled.");
  }
  return (
    <>
      <button type="button" className="tl-btn sm ghost" onClick={() => { setMessage(null); setOpen(true); }}>
        Cancel
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={batch.number}
        title={`Cancel ${batch.number}?`}
        footer={
          <>
            {message ? <span className="tl-note warn dlg-foot-msg" role="alert">{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy} onClick={() => void go()}>
              Cancel the batch
            </button>
          </>
        }>
        <form className="dlg-form" onSubmit={(e) => { e.preventDefault(); if (!busy) void go(); }}>
          <p className="tl-note dlg-lead">Its {batch.invoiceCount} {batch.invoiceCount === 1 ? "invoice goes" : "invoices go"} back to not being with a factor, so they can be sent another way or in another batch. The batch is kept in the list.</p>
          <DraftNote draft={kept} what="this reason" />
          <label className="tl-field">
            Why
            <input value={f.reason} onChange={(e) => setF({ reason: e.target.value })} maxLength={200} autoComplete="off" />
          </label>
        </form>
      </Modal>
    </>
  );
}
