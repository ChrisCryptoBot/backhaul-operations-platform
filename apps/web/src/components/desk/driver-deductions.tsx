"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { saveDeductionAction, setDeductionActiveAction } from "@/app/(desk)/actions";
import { BLANK_DEDUCTION, DEDUCTION_KINDS, DEDUCTION_ROW_LABEL, deductionKindLabel, validateDeduction, type DeductionRowKind, type DeductionRule, type DeductionValues } from "@/lib/deductions";
import { dayYear, usd } from "@/lib/desk-format";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * A driver's recurring deductions and escrow (docs/MONEY_PLAN.md, Wave 4 step 3): the rules, what each has taken or holds, and the latest ledger entries. A rule is offered on every draft
 * statement while it runs; it is stopped, never deleted, because the ledger names it.
 */
export type DeductionCardRule = { rule: DeductionRule; soFarCents: number };
export type DeductionCardEntry = { id: string; kind: string; label: string; amount: number; reason: string | null; statementId: string | null; statementNumber: string | null; at: string };

const money = (c: number) => usd(c / 100, 2);
const valuesOf = (r: DeductionRule): DeductionValues => ({ kind: r.kind, label: r.label, amount: (r.amountCents / 100).toFixed(2), goal: r.goalCents == null ? "" : (r.goalCents / 100).toFixed(2), startsOn: r.startsOn ?? "", endsOn: r.endsOn ?? "" });

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

function DeductionDialog({ open, onClose, driverId, rule }: { open: boolean; onClose: () => void; driverId: string; rule?: DeductionRule }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues, draft] = useDraft<DeductionValues>(`deduction:${driverId}:${rule?.id ?? "new"}`, rule ? valuesOf(rule) : BLANK_DEDUCTION);
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<keyof DeductionValues, string>>>({});
  const [message, setMessage] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setTried(false);
      setServerErrors({});
      setMessage("");
    }
  }, [open]);
  const check = validateDeduction(values);
  const errors = { ...(tried && !check.ok ? check.errors : {}), ...serverErrors };
  const set = (k: keyof DeductionValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));
  const escrow = values.kind === "escrow";

  return (
    <Modal open={open} onClose={onClose} eyebrow={rule ? "Edit deduction" : "New deduction"} title={rule ? rule.label : "Add a deduction"}>
      <DraftNote draft={draft} what="this deduction" />
      <form
        className="dlg-form"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!check.ok) return;
          start(async () => {
            const out = await saveDeductionAction(values, driverId, rule?.id ?? null);
            if (out.ok) {
              draft.saved();
              toast({ text: out.changed ? "Deduction saved. It is offered on the next draft statement." : "Nothing changed.", tone: "ok" });
              router.refresh();
              onClose();
            } else {
              setServerErrors(out.errors ?? {});
              setMessage(out.error ?? "");
            }
          });
        }}>
        <div className="dlg-two">
          <Fld label="What for" error={errors.kind}>
            <select value={values.kind} onChange={set("kind")}>
              {DEDUCTION_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </Fld>
          <Fld label="Name" error={errors.label} hint="As it shows on the statement.">
            <input data-autofocus value={values.label} onChange={set("label")} placeholder="Truck lease, unit 104" autoComplete="off" maxLength={60} />
          </Fld>
          <Fld label="Per statement ($)" error={errors.amount}>
            <input value={values.amount} onChange={set("amount")} inputMode="decimal" placeholder="250.00" autoComplete="off" />
          </Fld>
          <Fld label={escrow ? "Goal ($)" : "Cap ($), optional"} error={errors.goal} hint={escrow ? "The balance to hold. It stops once it is held." : "The most to take in all. Blank: no limit."}>
            <input value={values.goal} onChange={set("goal")} inputMode="decimal" placeholder={escrow ? "2500.00" : ""} autoComplete="off" />
          </Fld>
          <Fld label="From, optional" error={errors.startsOn} hint="Statements from this day.">
            <input type="date" value={values.startsOn} onChange={set("startsOn")} />
          </Fld>
          <Fld label="To, optional" error={errors.endsOn}>
            <input type="date" value={values.endsOn} onChange={set("endsOn")} />
          </Fld>
        </div>
        {message ? (
          <p className="tl-note warn" role="alert">
            {message}
          </p>
        ) : null}
        <div className="dlg-actions">
          <button type="button" className="tl-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="tl-btn primary" disabled={pending} aria-busy={pending || undefined}>
            {pending ? "Saving…" : rule ? "Save deduction" : "Add deduction"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditDeduction({ driverId, rule }: { driverId: string; rule?: DeductionRule }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className={`tl-btn sm${rule ? " ghost" : ""}`} onClick={() => setOpen(true)}>
        {rule ? "Edit" : "Add a deduction"}
      </button>
      <DeductionDialog open={open} onClose={() => setOpen(false)} driverId={driverId} rule={rule} />
    </>
  );
}

function StopStart({ rule }: { rule: DeductionRule }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  return (
    <button
      type="button"
      className="tl-btn ghost sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const out = await setDeductionActiveAction(rule.id, !rule.active);
          if (!out.ok) return toast({ text: out.error, tone: "bad" });
          toast({ text: rule.active ? `${rule.label} stopped.` : `${rule.label} started again.`, tone: "ok" });
          router.refresh();
        })
      }>
      {rule.active ? "Stop" : "Start again"}
    </button>
  );
}

export function DriverDeductions({ driverId, employee, escrowHeldCents, rules, ledger, canEdit }: { driverId: string; employee: boolean; escrowHeldCents: number; rules: DeductionCardRule[]; ledger: DeductionCardEntry[]; canEdit: boolean }) {
  return (
    <section className="tl-card f1099-gap">
      <div className="ded-head">
        <h2>Deductions and escrow · {money(escrowHeldCents)} held</h2>
        {canEdit && !employee ? <EditDeduction driverId={driverId} /> : null}
      </div>
      {employee ? (
        <p className="tl-note">A W-2 employee&apos;s deductions run through payroll, not the driver statement.</p>
      ) : rules.length === 0 ? (
        <p className="tl-note">No recurring deductions. A truck lease, insurance, ELD or escrow added here is proposed on every draft statement.</p>
      ) : (
        <table className="tl-table" aria-label="Recurring deductions">
          <thead>
            <tr>
              <th>Deduction</th>
              <th className="num">Per statement</th>
              <th className="num">Goal or cap</th>
              <th className="num">So far</th>
              <th>Runs</th>
              {canEdit ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {rules.map(({ rule: r, soFarCents }) => (
              <tr key={r.id}>
                <td>
                  {r.label}
                  <div className="tl-sub">
                    {deductionKindLabel(r.kind)}
                    {r.active ? "" : " · stopped"}
                  </div>
                </td>
                <td className="num">{money(r.amountCents)}</td>
                <td className="num">{r.goalCents == null ? <span className="dim">—</span> : money(r.goalCents)}</td>
                <td className="num">
                  {money(soFarCents)} {r.kind === "escrow" ? "held" : "taken"}
                </td>
                <td>{r.startsOn || r.endsOn ? `${r.startsOn ?? "start"} to ${r.endsOn ?? "no end"}` : "Every statement"}</td>
                {canEdit ? (
                  <td className="ded-actions">
                    <EditDeduction driverId={driverId} rule={r} />
                    <StopStart rule={r} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ledger.length > 0 ? (
        <>
          <h3 className="ded-sub">Ledger · latest {ledger.length}</h3>
          <table className="tl-table" aria-label="Deduction and escrow ledger">
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td>{dayYear(e.at)}</td>
                  <td>
                    {DEDUCTION_ROW_LABEL[e.kind as DeductionRowKind] ?? e.kind} · {e.label}
                    {e.reason ? <div className="tl-sub">{e.reason}</div> : null}
                  </td>
                  <td>{e.statementId ? <Link href={`/settlements/${e.statementId}`}>{e.statementNumber}</Link> : <span className="dim">—</span>}</td>
                  <td className="num">{usd(e.amount, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
