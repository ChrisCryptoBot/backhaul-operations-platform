"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { saveCustomerAction } from "@/app/(desk)/actions";
import { CUSTOMER_KINDS, validateCustomer, type CustomerValues } from "@/lib/customer";
import { AuthorityStatus, useAuthorityLookup } from "./customer-authority";
import { useToast } from "./kit/toast";

/**
 * A customer's record: what kind it is, its MC (a broker or carrier has one; a shipper or direct customer has none, and leaving it blank is
 * fine), who to write to about an invoice, the terms it usually pays on, and a note. The MC is checked at FMCSA when its box is left, display only.
 * Changing the name renames the customer on every load that carries it.
 */
export function CustomerForm({ id, stored, loads }: { id: string | null; stored: CustomerValues; loads: number }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues] = React.useState<CustomerValues>(stored);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<keyof CustomerValues, string>>>({});
  const authority = useAuthorityLookup();
  const check = React.useMemo(() => validateCustomer(values), [values]);
  const shown = { ...serverErrors, ...(check.ok ? {} : check.errors) };
  const unchanged = id != null && (Object.keys(stored) as Array<keyof CustomerValues>).every((k) => values[k].trim() === stored[k].trim());
  const set = (k: keyof CustomerValues, v: string) => {
    setServerErrors((e) => ({ ...e, [k]: undefined }));
    setValues((s) => ({ ...s, [k]: v }));
  };
  const renaming = id != null && values.name.trim().replace(/\s+/g, " ") !== stored.name && loads > 0;

  const field = (k: keyof CustomerValues, label: string, opts: { hint?: string; wide?: boolean; area?: boolean; inputMode?: "numeric" | "tel" | "email"; extra?: React.ReactNode; onBlur?: () => void; onChange?: () => void } = {}) => (
    <div className="th-field" key={k} style={opts.wide ? { gridColumn: "1 / -1" } : undefined}>
      <label htmlFor={`cu-${k}`}>{label}</label>
      {opts.area ? (
        <textarea id={`cu-${k}`} rows={2} value={values[k]} aria-invalid={shown[k] ? true : undefined} onChange={(e) => set(k, e.target.value)} />
      ) : (
        <input
          id={`cu-${k}`}
          value={values[k]}
          inputMode={opts.inputMode}
          autoComplete="off"
          aria-invalid={shown[k] ? true : undefined}
          onChange={(e) => {
            opts.onChange?.();
            set(k, e.target.value);
          }}
          onBlur={opts.onBlur}
        />
      )}
      {opts.extra}
      {shown[k] ? (
        <span className="th-err" role="alert">
          {shown[k]}
        </span>
      ) : opts.hint ? (
        <span className="th-hint">{opts.hint}</span>
      ) : null}
    </div>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!check.ok) return;
        setServerErrors({});
        start(async () => {
          const out = await saveCustomerAction(values, id);
          if (!out.ok) {
            setServerErrors(out.errors ?? {});
            if (out.error) toast({ text: out.error, tone: "bad" });
            return;
          }
          toast({ text: out.changed ? "Customer saved." : "Nothing changed.", tone: "ok" });
          if (id == null) router.push(`/customers/${out.id}`);
          else router.refresh();
        });
      }}>
      <div className="th-grid">
        {field("name", "Name", { hint: "As it is on the rate confirmation or invoice.", extra: renaming ? <span className="th-hint">{`This renames the customer on its ${loads} ${loads === 1 ? "load" : "loads"}.`}</span> : null })}
        <div className="th-field" role="group" aria-label="Kind">
          <span className="th-label">Kind</span>
          <div className="cp-seg">
            {CUSTOMER_KINDS.map((k) => (
              <button key={k.key} type="button" aria-pressed={values.kind === k.key} onClick={() => set("kind", k.key)}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
        {field("mcNumber", "MC number (brokers and carriers)", {
          hint: "Leave blank for a shipper or direct customer.",
          inputMode: "numeric",
          onChange: () => authority.reset(),
          onBlur: () => void authority.check(values.mcNumber, values.name, (name) => setValues((s) => (s.name.trim() === "" ? { ...s, name } : s))),
          extra: <AuthorityStatus busy={authority.busy} result={authority.result} />
        })}
        {field("defaultPayTermsDays", "Usual pay terms (days)", { hint: "Used on an invoice to this customer when the load names no terms. Blank uses the desk's.", inputMode: "numeric" })}
        {field("contactName", "Billing contact")}
        {field("contactEmail", "Billing email", { inputMode: "email", hint: "Where an invoice and a reminder go." })}
        {field("contactPhone", "Billing phone", { inputMode: "tel" })}
        {field("notes", "Notes", { area: true, wide: true, hint: "Anything the next dispatcher should know: how they pay, who to ask for." })}
      </div>
      <div className="th-actions">
        <button type="submit" className="tl-btn primary" disabled={pending || !check.ok || unchanged} aria-busy={pending || undefined}>
          {pending ? "Saving…" : id == null ? "Add this customer" : "Save customer"}
        </button>
        {unchanged ? <span className="tl-sub">Saved.</span> : null}
      </div>
    </form>
  );
}
