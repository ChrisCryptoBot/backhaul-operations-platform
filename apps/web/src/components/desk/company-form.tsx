"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { saveCompanyAction } from "@/app/(desk)/actions";
import { validateCompany, type CompanyValues } from "@/lib/company";
import { useToast } from "./kit/toast";

const FIELDS: Array<{ key: keyof CompanyValues; label: string; hint?: string; wide?: boolean; area?: boolean; inputMode?: "numeric" | "tel" | "email" }> = [
  { key: "name", label: "Company name", hint: "As it prints on an invoice and a driver's statement." },
  { key: "mcNumber", label: "MC number", hint: "Digits only.", inputMode: "numeric" },
  { key: "dotNumber", label: "DOT number", hint: "Digits only.", inputMode: "numeric" },
  { key: "phone", label: "Phone", inputMode: "tel" },
  { key: "email", label: "Billing email", hint: "Where a customer writes about an invoice.", inputMode: "email" },
  { key: "address", label: "Address", hint: "The mailing address on the invoice.", area: true, wide: true },
  { key: "remitTo", label: "Remit payment to", hint: "A bank, a factor or a lockbox, so a customer knows where to send it.", area: true, wide: true },
  { key: "paymentNote", label: "Payment note", hint: "A line under every invoice, for example how a late fee works.", area: true, wide: true }
];

/** The company's name, authority numbers, address and where payments go: printed on every invoice and statement. Only the name is required. */
export function CompanyForm({ stored }: { stored: CompanyValues }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues] = React.useState<CompanyValues>(stored);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<keyof CompanyValues, string>>>({});
  const check = React.useMemo(() => validateCompany(values), [values]);
  const shown = { ...serverErrors, ...(check.ok ? {} : check.errors) };
  const unchanged = (Object.keys(stored) as Array<keyof CompanyValues>).every((k) => values[k].trim() === stored[k].trim());

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!check.ok) return;
        setServerErrors({});
        start(async () => {
          const out = await saveCompanyAction(values);
          if (out.ok) {
            toast({ text: out.changed ? "Company details saved." : "Nothing changed.", tone: "ok" });
            router.refresh();
          } else setServerErrors(out.errors);
        });
      }}>
      <div className="th-grid">
        {FIELDS.map((f) => {
          const id = `co-${f.key}`;
          return (
            <div className="th-field" key={f.key} style={f.wide ? { gridColumn: "1 / -1" } : undefined}>
              <label htmlFor={id}>{f.label}</label>
              {f.area ? (
                <textarea id={id} rows={2} value={values[f.key]} aria-invalid={shown[f.key] ? true : undefined} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
              ) : (
                <input id={id} value={values[f.key]} inputMode={f.inputMode} autoComplete="off" aria-invalid={shown[f.key] ? true : undefined} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
              )}
              {f.hint ? <span className="th-hint">{f.hint}</span> : null}
              {shown[f.key] ? (
                <span className="th-err" role="alert">
                  {shown[f.key]}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="th-actions">
        <button type="submit" className="tl-btn primary" disabled={pending || !check.ok || unchanged} aria-busy={pending || undefined}>
          {pending ? "Saving…" : "Save company details"}
        </button>
        {unchanged ? <span className="tl-sub">Saved.</span> : null}
      </div>
    </form>
  );
}
