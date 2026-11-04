"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { saveBillingDetailsAction } from "@/app/(desk)/actions";
import { validateBillingDetails, type BillingDetailsValues } from "@/lib/billing-details";
import { Modal } from "./kit/modal";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";
import { DraftNote, useDraft } from "./kit/use-draft";

function Fld({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="tl-field">
      {label}
      {children}
      {error ? (
        <span className="th-err" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="th-hint">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * The accounting office's way to correct a load: who it is billed to, how to reach them, the PO, the terms and a note on the revenue. Nothing about the freight. Once the load is
 * invoiced the customer, PO and terms are held (the server says so); the contact and the note can still be corrected.
 */
export function BillingDetailsDialog({ loadId, loadNumber, initial, invoiced }: { loadId: string; loadNumber: string; initial: BillingDetailsValues; invoiced: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [v, setV, kept] = useDraft<BillingDetailsValues>(`billing-details:${loadId}`, initial);
  const set = (k: keyof BillingDetailsValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });

  async function save() {
    const c = validateBillingDetails(v);
    if (!c.ok) return setErrors(c.errors);
    setErrors({});
    setMessage(null);
    setBusy(true);
    const got = await tried(() => saveBillingDetailsAction(loadId, v));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (out.ok) {
      kept.saved();
      setOpen(false);
      toast({ text: out.changed ? "Billing details saved." : "Nothing was different.", tone: "ok" });
      router.refresh();
    } else {
      setErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked.");
    }
  }

  return (
    <>
      <button
        type="button"
        className="tl-btn sm"
        onClick={() => {
          setErrors({});
          setMessage(null);
          setOpen(true);
        }}>
        Edit billing details
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={loadNumber}
        title="Billing details"
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </>
        }>
        <form
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}>
          <DraftNote draft={kept} what="this load's billing details" />
          {invoiced ? <p className="tl-note">This load is invoiced, so the customer, PO and terms stay as billed. The contact and the note can still be corrected.</p> : null}
          <Fld label="Billed to" error={errors.brokerName}>
            <input value={v.brokerName} onChange={set("brokerName")} disabled={invoiced} autoComplete="off" />
          </Fld>
          <div className="dlg-two">
            <Fld label="MC number" error={errors.brokerMcNumber}>
              <input inputMode="numeric" value={v.brokerMcNumber} onChange={set("brokerMcNumber")} autoComplete="off" />
            </Fld>
            <Fld label="Customer PO" error={errors.poNumber}>
              <input value={v.poNumber} onChange={set("poNumber")} disabled={invoiced} autoComplete="off" />
            </Fld>
          </div>
          <div className="dlg-two">
            <Fld label="Accounts email" error={errors.brokerEmail}>
              <input type="email" value={v.brokerEmail} onChange={set("brokerEmail")} autoComplete="off" />
            </Fld>
            <Fld label="Accounts phone" error={errors.brokerPhone}>
              <input value={v.brokerPhone} onChange={set("brokerPhone")} autoComplete="off" />
            </Fld>
          </div>
          <Fld label="Pay terms (days)" error={errors.payTermsDays} hint="0 is due on receipt. Blank uses the customer's terms, else the desk's.">
            <input inputMode="numeric" value={v.payTermsDays} onChange={set("payTermsDays")} disabled={invoiced} autoComplete="off" />
          </Fld>
          <Fld label="Note on the revenue" error={errors.revenueNote} hint="Why it is what it is: a short pay, or a detention the customer agreed to.">
            <input value={v.revenueNote} onChange={set("revenueNote")} autoComplete="off" />
          </Fld>
        </form>
      </Modal>
    </>
  );
}
