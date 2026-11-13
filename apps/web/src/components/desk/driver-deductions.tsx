"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { recordAdvanceAction, saveDeductionAction, setAdvanceActiveAction, setDeductionActiveAction } from "@/app/(desk)/actions";
import { ADVANCE_METHODS, advanceLabel, BLANK_ADVANCE, BLANK_DEDUCTION, DEDUCTION_KINDS, deductionKindLabel, LEDGER_KIND_LABEL, validateAdvance, validateDeduction, type AdvanceRecord, type AdvanceValues, type DeductionRule, type DeductionValues } from "@/lib/deductions";
import { dayYear, usd } from "@/lib/desk-format";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * A driver's recurring deductions and escrow (docs/MONEY_PLAN.md, Wave 4 step 3): the rules, what each has taken or holds, and the latest ledger entries. A rule is offered on every draft
 * statement while it runs; it is stopped, never deleted, because the ledger names it.
 */
export type DeductionCardRule = { rule: DeductionRule; soFarCents: number };
export type AdvanceCardRow = { advance: AdvanceRecord; owedCents: number };
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

/** Record money given ahead of pay. Payout's act (it is money out); the advance and its ledger entry are written together on the server. */
function AdvanceDialog({ open, onClose, driverId, today }: { open: boolean; onClose: () => void; driverId: string; today: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues, draft] = useDraft<AdvanceValues>(`advance:${driverId}`, { ...BLANK_ADVANCE, givenOn: today });
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<keyof AdvanceValues, string>>>({});
  const [message, setMessage] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setTried(false);
      setServerErrors({});
      setMessage("");
    }
  }, [open]);
  const check = validateAdvance(values, today);
  const errors = { ...(tried && !check.ok ? check.errors : {}), ...serverErrors };
  const set = (k: keyof AdvanceValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));
  return (
    <Modal open={open} onClose={onClose} eyebrow="Advance" title="Record an advance">
      <DraftNote draft={draft} what="this advance" />
      <form
        className="dlg-form"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!check.ok) return;
          start(async () => {
            const out = await recordAdvanceAction(values, driverId);
            if (out.ok) {
              draft.saved();
              toast({ text: "Advance recorded. Its repayment is proposed on the next draft statement.", tone: "ok" });
              router.refresh();
              onClose();
            } else {
              setServerErrors(out.errors ?? {});
              setMessage(out.error ?? "");
            }
          });
        }}>
        <div className="dlg-two">
          <Fld label="Amount given ($)" error={errors.amount}>
            <input data-autofocus value={values.amount} onChange={set("amount")} inputMode="decimal" placeholder="500.00" autoComplete="off" />
          </Fld>
          <Fld label="Given on" error={errors.givenOn}>
            <input type="date" value={values.givenOn} max={today} onChange={set("givenOn")} />
          </Fld>
          <Fld label="How" error={errors.method}>
            <select value={values.method} onChange={set("method")}>
              {ADVANCE_METHODS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </Fld>
          <Fld label="Repaid per statement ($)" error={errors.repay} hint="Proposed on each statement until it is cleared.">
            <input value={values.repay} onChange={set("repay")} inputMode="decimal" placeholder="100.00" autoComplete="off" />
          </Fld>
        </div>
        <Fld label="Note, optional" error={errors.note}>
          <input value={values.note} onChange={set("note")} placeholder="Tires in Amarillo" autoComplete="off" maxLength={120} />
        </Fld>
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
            {pending ? "Saving…" : "Record advance"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RecordAdvance({ driverId, today }: { driverId: string; today: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="tl-btn sm" onClick={() => setOpen(true)}>
        Record an advance
      </button>
      <AdvanceDialog open={open} onClose={() => setOpen(false)} driverId={driverId} today={today} />
    </>
  );
}

function PauseResume({ advance }: { advance: AdvanceRecord }) {
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
          const out = await setAdvanceActiveAction(advance.id, !advance.active);
          if (!out.ok) return toast({ text: out.error, tone: "bad" });
          toast({ text: advance.active ? "Repayment paused." : "Repayment resumed.", tone: "ok" });
          router.refresh();
        })
      }>
      {advance.active ? "Pause repayment" : "Resume repayment"}
    </button>
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

export function DriverDeductions({ driverId, employee, escrowHeldCents, owedCents = 0, rules, advances = [], ledger, canEdit, canRecordAdvance = false, today = "" }: { driverId: string; employee: boolean; escrowHeldCents: number; owedCents?: number; rules: DeductionCardRule[]; advances?: AdvanceCardRow[]; ledger: DeductionCardEntry[]; canEdit: boolean; canRecordAdvance?: boolean; today?: string }) {
  return (
    <section className="tl-card f1099-gap">
      <div className="ded-head">
        <h2>
          Deductions, escrow and advances · {money(escrowHeldCents)} held · {money(owedCents)} owed
        </h2>
        <div className="ded-actions">
          {canRecordAdvance && !employee ? <RecordAdvance driverId={driverId} today={today} /> : null}
          {canEdit && !employee ? <EditDeduction driverId={driverId} /> : null}
        </div>
      </div>
      {employee ? (
        <p className="tl-note">A W-2 employee&apos;s deductions and advances run through payroll, not the driver statement.</p>
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
      {advances.length > 0 ? (
        <>
          <h3 className="ded-sub">Advances</h3>
          <table className="tl-table" aria-label="Advances">
            <thead>
              <tr>
                <th>Advance</th>
                <th className="num">Repaid per statement</th>
                <th className="num">Still owed</th>
                {canEdit ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {advances.map(({ advance: a, owedCents: owed }) => (
                <tr key={a.id}>
                  <td>
                    {advanceLabel(a)}
                    <div className="tl-sub">
                      {owed === 0 ? "Cleared" : a.active ? "Repaying" : "Repayment paused"}
                      {a.note ? ` · ${a.note}` : ""}
                    </div>
                  </td>
                  <td className="num">{money(a.repayCents)}</td>
                  <td className="num">{money(owed)}</td>
                  {canEdit ? <td className="ded-actions">{owed > 0 ? <PauseResume advance={a} /> : null}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {ledger.length > 0 ? (
        <>
          <h3 className="ded-sub">Ledger · latest {ledger.length}</h3>
          <table className="tl-table" aria-label="Deduction and escrow ledger">
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td>{dayYear(e.at)}</td>
                  <td>
                    {LEDGER_KIND_LABEL[e.kind] ?? e.kind} · {e.label}
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
