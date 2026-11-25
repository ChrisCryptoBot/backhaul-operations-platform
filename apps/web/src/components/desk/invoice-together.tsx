"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { invoiceLoadsAction } from "@/app/(desk)/actions";
import { customerKey, MAX_LOADS_PER_INVOICE } from "@/lib/customer-key";
import { shortDate, usd } from "@/lib/desk-format";
import { termsLabel } from "@/lib/invoicing";
import { dueAt } from "@/lib/overdue";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * "Invoice these loads together" (docs/MONEY_PLAN.md, rule G). Each row of the ready-to-invoice list gets a checkbox; once two or more are ticked a bar says what is chosen and the
 * button opens one invoice for all of them. Every load on one invoice must bill the same customer (the same name and MC): when the ticked loads do not, the button is off and
 * says why. The server checks the same rule again; this only explains it before the click.
 */
export type TogetherLoad = {
  id: string;
  loadNumber: string | null;
  customer: string | null;
  mc: string | null;
  /** Line haul plus fuel surcharge in cents (detention is added on a load's own invoice, not here). */
  cents: number;
  /** The number the load's own invoice would start from. */
  defaultNumber: string;
  defaultTerms: number;
  /** Why this load cannot be invoiced yet, when it cannot. */
  blocked: string | null;
};

type Ctx = { loads: Map<string, TogetherLoad>; picked: string[]; toggle: (id: string) => void; clear: () => void; canPick: boolean };
const TogetherContext = React.createContext<Ctx | null>(null);

export function TogetherProvider({ loads, canPick, children }: { loads: TogetherLoad[]; canPick: boolean; children: React.ReactNode }) {
  const map = React.useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads]);
  const [picked, setPicked] = React.useState<string[]>([]);
  // A page of the list that no longer shows a ticked load (it was invoiced, or the page changed) drops it from the choice.
  React.useEffect(() => {
    setPicked((p) => (p.every((id) => map.has(id)) ? p : p.filter((id) => map.has(id))));
  }, [map]);
  const value = React.useMemo<Ctx>(
    () => ({
      loads: map,
      picked,
      canPick,
      toggle: (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_LOADS_PER_INVOICE ? p : [...p, id])),
      clear: () => setPicked([])
    }),
    [map, picked, canPick]
  );
  return <TogetherContext.Provider value={value}>{children}</TogetherContext.Provider>;
}

/** The checkbox at the start of a ready row. */
export function TogetherPick({ id }: { id: string }) {
  const ctx = React.useContext(TogetherContext);
  const load = ctx?.loads.get(id);
  if (!ctx || !ctx.canPick || !load) return null;
  const on = ctx.picked.includes(id);
  return (
    <input
      type="checkbox"
      className="tl-pick"
      checked={on}
      disabled={!!load.blocked && !on}
      onChange={() => ctx.toggle(id)}
      aria-label={`Put ${load.loadNumber ?? "this load"} on one invoice with others`}
      title={load.blocked ?? "Tick two or more loads of one customer to invoice them together"}
    />
  );
}

/** Why the ticked loads cannot go on one invoice, or null when they can. */
export function togetherProblem(chosen: TogetherLoad[]): string | null {
  if (chosen.length < 2) return "Tick at least two loads.";
  const blocked = chosen.find((l) => l.blocked);
  if (blocked) return `${blocked.loadNumber ?? "A load"} cannot be invoiced yet: ${blocked.blocked}`;
  const first = chosen[0]!;
  const key = customerKey({ brokerName: first.customer, brokerMcNumber: first.mc });
  const other = chosen.find((l) => customerKey({ brokerName: l.customer, brokerMcNumber: l.mc }) !== key);
  if (other) return `One invoice bills one customer: ${first.loadNumber ?? "the first load"} is for ${first.customer ?? "no customer"} and ${other.loadNumber ?? "another"} is for ${other.customer ?? "no customer"}${first.customer && other.customer && first.customer.trim().toLowerCase() === other.customer.trim().toLowerCase() ? " (a different MC number)" : ""}.`;
  return null;
}

/** A short stable name for a set of loads, so the dialog keeps what was typed for that set. */
function setKey(ids: string[]): string {
  let h = 5381;
  for (const ch of [...ids].sort().join(",")) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

export function TogetherBar() {
  const ctx = React.useContext(TogetherContext);
  const [open, setOpen] = React.useState(false);
  if (!ctx || !ctx.canPick || ctx.picked.length === 0) return null;
  const chosen = ctx.picked.map((id) => ctx.loads.get(id)).filter((l): l is TogetherLoad => !!l);
  const total = chosen.reduce((s, l) => s + l.cents, 0);
  const problem = chosen.length >= 2 ? togetherProblem(chosen) : null;
  const customer = chosen[0]?.customer ?? "no customer";
  return (
    <div className="tl-together" role="region" aria-label="Loads chosen for one invoice">
      <span>
        <b>{chosen.length}</b> {chosen.length === 1 ? "load" : "loads"} selected · <b>{usd(total / 100, 2)}</b> · {customer}
      </span>
      {problem && chosen.length >= 2 ? <span className="tl-note warn" role="status">{problem}</span> : chosen.length < 2 ? <span className="tl-note">Tick one more of the same customer to bill them on one invoice.</span> : null}
      <span className="tl-together-act">
        <button type="button" className="tl-btn ghost sm" onClick={ctx.clear}>
          Clear
        </button>
        <button type="button" className="tl-btn primary sm" disabled={!!togetherProblem(chosen)} title={togetherProblem(chosen) ?? undefined} onClick={() => setOpen(true)}>
          Invoice these loads together
        </button>
      </span>
      {open && chosen.length >= 2 ? <TogetherDialog chosen={chosen} onClose={() => setOpen(false)} onDone={ctx.clear} /> : null}
    </div>
  );
}

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

export function TogetherDialog({ chosen, onClose, onDone }: { chosen: TogetherLoad[]; onClose: () => void; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const ids = chosen.map((l) => l.id);
  const first = chosen[0]!;
  const [f, setF, kept] = useDraft<{ number: string; terms: string }>(`invoice-together:${setKey(ids)}`, { number: first.defaultNumber, terms: "" });
  const [errors, setErrors] = React.useState<{ number?: string; terms?: string }>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const total = chosen.reduce((s, l) => s + l.cents, 0);
  const termsDays = f.terms.trim() === "" ? first.defaultTerms : /^\d{1,3}$/.test(f.terms.trim()) ? Number.parseInt(f.terms.trim(), 10) : NaN;
  const dueDay = Number.isInteger(termsDays) && termsDays >= 0 && termsDays <= 120 ? dueAt(new Date(), termsDays) : null;

  async function create() {
    setErrors({});
    setMessage(null);
    if (f.number.trim().length < 3) return setErrors({ number: "Give the invoice a number." });
    setBusy(true);
    const got = await tried(() => invoiceLoadsAction(ids, { number: f.number, terms: f.terms }));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (out.ok) {
      kept.saved();
      onDone();
      onClose();
      toast({ text: `${out.number} created for ${usd(out.total ?? 0, 2)} across ${chosen.length} loads.`, tone: "ok" });
      router.push(`/invoices/${first.id}`);
    } else {
      setErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked.");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${chosen.length} loads`}
      title="One invoice for these loads"
      footer={
        <>
          {message ? <span className="tl-note warn dlg-foot-msg" role="alert">{message}</span> : null}
          <button type="button" className="tl-btn" onClick={onClose}>
            Back
          </button>
          <button type="button" className="tl-btn primary" disabled={busy} onClick={() => void create()}>
            Create invoice
          </button>
        </>
      }>
      <form
        className="dlg-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void create();
        }}>
        <p className="tl-note dlg-lead">
          Billed to <b>{first.customer ?? "no customer"}</b>. Each load keeps its own line haul and fuel surcharge on the invoice. Detention, lumper and layover are added on a load&apos;s own invoice, so a load that has them is best invoiced alone.
        </p>
        <DraftNote draft={kept} what="this invoice" />
        <div className="dlg-two">
          <Fld label="Invoice number" error={errors.number}>
            <input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} autoComplete="off" />
          </Fld>
          <Fld label="Pay terms (days)" error={errors.terms} hint={`${dueDay ? `Due ${shortDate(dueDay)}. ` : ""}Blank uses ${termsLabel(first.defaultTerms)}.`}>
            <input inputMode="numeric" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} />
          </Fld>
        </div>
        <dl className="rc-facts">
          {chosen.map((l) => (
            <div key={l.id}>
              <dt>{l.loadNumber ?? "Load"}</dt>
              <dd>{usd(l.cents / 100, 2)}</dd>
            </div>
          ))}
          <div>
            <dt>
              <b>Total due</b>
            </dt>
            <dd>
              <b>{usd(total / 100, 2)}</b>
            </dd>
          </div>
        </dl>
      </form>
    </Modal>
  );
}
