"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { saveFactoringTermsAction } from "@/app/(desk)/actions";
import { economicsOf } from "@/lib/factoring-economics";
import { usd } from "@/lib/desk-format";
import { BLANK_TERMS, validateTerms, type TermsForm } from "@/lib/factoring-terms";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * The fleet's factoring terms (docs/MONEY_PLAN.md, Wave 2): where a factored invoice must be paid, the notice wording, and the advance and fee the factor charges. Printed on the
 * invoice PDF once an invoice goes to the factor, and used to work out what the factor owes when it funds. An admin saves them; everyone else sees them read-only.
 */
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

export function FactoringTermsForm({ initial, canEdit }: { initial: TermsForm; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF, kept] = useDraft<TermsForm>("factoring-terms", initial ?? BLANK_TERMS);
  const [errors, setErrors] = React.useState<Partial<Record<keyof TermsForm, string>>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof TermsForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const check = validateTerms(f);
  const example = check.ok && check.value.advancePct ? economicsOf(1000, { advancePct: check.value.advancePct, feePct: check.value.feePct }) : null;

  async function save() {
    setErrors({});
    setMessage(null);
    if (!check.ok) return setErrors(check.errors);
    setBusy(true);
    const got = await tried(() => saveFactoringTermsAction(f));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    if (got.value.ok) {
      kept.saved();
      toast({ text: got.value.changed ? "Factoring terms saved." : "Nothing had changed.", tone: "ok" });
      router.refresh();
    } else setErrors(got.value.errors);
  }

  return (
    <form
      className="dlg-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canEdit && !busy) void save();
      }}>
      <DraftNote draft={kept} what="these terms" />
      <div className="dlg-two">
        <Fld label="Factoring company" error={errors.factorName} hint="Named on the notice of assignment.">
          <input value={f.factorName} onChange={set("factorName")} disabled={!canEdit} maxLength={80} autoComplete="off" />
        </Fld>
        <Fld label="Make payment to" error={errors.remitName} hint="The payee name on the factor's remit-to.">
          <input value={f.remitName} onChange={set("remitName")} disabled={!canEdit} maxLength={120} autoComplete="off" />
        </Fld>
      </div>
      <Fld label="Remit-to address" error={errors.remitAddress} hint="Where customers send a factored invoice's payment. One line each.">
        <textarea value={f.remitAddress} onChange={set("remitAddress")} disabled={!canEdit} rows={3} maxLength={300} />
      </Fld>
      <div className="dlg-two">
        <Fld label="Lockbox bank" error={errors.lockboxBank} hint="Optional.">
          <input value={f.lockboxBank} onChange={set("lockboxBank")} disabled={!canEdit} maxLength={120} autoComplete="off" />
        </Fld>
        <Fld label="Routing number" error={errors.routingNumber} hint="Nine digits. Optional.">
          <input inputMode="numeric" value={f.routingNumber} onChange={set("routingNumber")} disabled={!canEdit} autoComplete="off" />
        </Fld>
      </div>
      <Fld label="Account number" error={errors.accountNumber} hint="The factor's lockbox account for customers to pay into, as the factor gave it to you. Printed on factored invoices. Never your own account.">
        <input inputMode="numeric" value={f.accountNumber} onChange={set("accountNumber")} disabled={!canEdit} autoComplete="off" />
      </Fld>
      <Fld label="Notice of assignment wording" error={errors.noaText} hint="Optional. The factor's own statutory wording, printed on the invoice. Blank uses plain wording that says the invoice is payable only to the factor.">
        <textarea value={f.noaText} onChange={set("noaText")} disabled={!canEdit} rows={3} maxLength={600} />
      </Fld>
      <div className="dlg-two">
        <Fld label="Advance (%)" error={errors.advancePct} hint="What the factor pays at once, like 90.">
          <input inputMode="decimal" value={f.advancePct} onChange={set("advancePct")} disabled={!canEdit} autoComplete="off" />
        </Fld>
        <Fld label="Fee (%)" error={errors.feePct} hint="Taken from the reserve when the customer pays, like 2.5.">
          <input inputMode="decimal" value={f.feePct} onChange={set("feePct")} disabled={!canEdit} autoComplete="off" />
        </Fld>
      </div>
      {example ? (
        <p className="tl-note dlg-lead">
          On a {usd(1000, 2)} invoice: {usd(example.advance, 2)} up front, {usd(example.reserveHeld, 2)} held, {usd(example.fee, 2)} fee, {usd(example.reserveReleasable, 2)} released when the customer pays, {usd(example.netToCarrier, 2)} in all.
        </p>
      ) : null}
      <div className="dlg-foot-row">
        {message ? <span className="tl-note warn" role="alert">{message}</span> : null}
        {canEdit ? (
          <button type="submit" className="tl-btn primary" disabled={busy}>
            Save the factoring terms
          </button>
        ) : (
          <span className="tl-sub">An admin saves these.</span>
        )}
      </div>
    </form>
  );
}
