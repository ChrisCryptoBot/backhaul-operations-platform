"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { completeTripAction, invoiceLoadAction, paidAction, saveExpensesAction, saveLoadDetailsAction, startTripAction } from "@/app/(desk)/actions";
import { usd } from "@/lib/desk-format";
import { validateInvoice, type InvoiceContext, type InvoiceForm } from "@/lib/invoicing";
import { validateLoadEdit, type DealValues, type EditStopValues, type LoadEditValues } from "@/lib/load-edit";
import { validateComplete, validateExpenses, validateStart, type CompleteValues, type ExpenseValues, type StartValues } from "@/lib/trip";
import { toCentralLocal } from "@/lib/zoned";
import { TRAILER_TYPES } from "@/truelane/constants/trailerData";
import { AddressInput } from "./address-input";
import { PAID_METHODS } from "@/lib/pay-method";
import { AuthorityStatus, useAuthorityLookup } from "./customer-authority";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";

type Errors = Record<string, string>;

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

const nowLocal = () => toCentralLocal(Date.now());

// ── Edit a load ────────────────────────────────────────────────────────────────────────────────

/**
 * Change what a load says: who it is for, its numbers, weight and size, what it needs, notes, and each stop's place, times, references and
 * contact. A load that has started keeps its stops where they are (its details can still be corrected). A driver who already has it is asked to
 * confirm again if a place or time changes.
 */
export function LoadEditDialog({ loadId, loadNumber, initial, scheduleLocked, driverName, trucks, dealLocked }: { loadId: string; loadNumber: string; initial: LoadEditValues; scheduleLocked: boolean; driverName: string | null; trucks: Array<{ id: string; name: string; ready: boolean }>; dealLocked: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [v, setV] = React.useState<LoadEditValues>(initial);
  const [errors, setErrors] = React.useState<Errors>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setV(initial);
      authority.reset();
      setErrors({});
      setMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const authority = useAuthorityLookup();
  const set = (patch: Partial<LoadEditValues>) => setV((s) => ({ ...s, ...patch }));
  const setStop = (i: number, patch: Partial<EditStopValues>) => setV((s) => ({ ...s, stops: s.stops.map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
  const setDeal = (patch: Partial<DealValues>) => setV((s) => (s.deal ? { ...s, deal: { ...s.deal, ...patch } } : s));
  const money = (key: keyof DealValues, label: string, opts: { hint?: string; unit?: string } = {}) => (
    <Fld label={label} error={errors[`deal.${key}`]} hint={opts.hint}>
      <input value={v.deal?.[key] ?? ""} inputMode="decimal" autoComplete="off" disabled={dealLocked != null} onChange={(e) => setDeal({ [key]: e.target.value } as Partial<DealValues>)} aria-invalid={errors[`deal.${key}`] ? true : undefined} />
    </Fld>
  );
  const text = (key: keyof LoadEditValues, label: string, opts: { hint?: string; inputMode?: "decimal" | "numeric" | "tel" | "email" } = {}) => (
    <Fld label={label} error={errors[key]} hint={opts.hint}>
      <input value={String(v[key] ?? "")} inputMode={opts.inputMode} autoComplete="off" onChange={(e) => set({ [key]: e.target.value } as Partial<LoadEditValues>)} aria-invalid={errors[key] ? true : undefined} />
    </Fld>
  );

  async function save() {
    const check = validateLoadEdit(v);
    if (!check.ok) {
      setErrors(check.errors);
      setMessage("Fix what is marked, then save.");
      return;
    }
    setBusy(true);
    const out = await saveLoadDetailsAction(loadId, v);
    setBusy(false);
    if (out.ok) {
      setOpen(false);
      toast({ text: out.changed ? "Details saved." : "Nothing changed.", tone: "ok" });
      if (out.note) toast({ text: out.note, tone: "ok" });
      router.refresh();
    } else {
      setErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked, then save.");
    }
  }

  return (
    <>
      <button type="button" className="tl-btn sm" onClick={() => setOpen(true)}>
        Edit details
      </button>
      <Modal
        wide
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={loadNumber}
        title="Edit this load"
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="tl-btn primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>
              {busy ? "Saving…" : "Save details"}
            </button>
          </>
        }>
        <div className="le">
          {v.deal ? (
            <>
              <h3 className="th-group">The deal</h3>
              {dealLocked ? <p className="tl-note" style={{ marginBottom: 8 }}>{dealLocked}</p> : null}
              <div className="rc-grid">
                <Fld label="Truck" error={errors["deal.vehicleId"]} hint={!dealLocked && scheduleLocked ? "A load that has started keeps its truck." : undefined}>
                  <select value={v.deal.vehicleId} disabled={dealLocked != null || scheduleLocked} onChange={(e) => setDeal({ vehicleId: e.target.value })}>
                    {initial.deal?.vehicleId === "" ? <option value="">No truck yet</option> : null}
                    {trucks.map((t) => (
                      <option key={t.id} value={t.id} disabled={!t.ready && t.id !== initial.deal?.vehicleId}>
                        {t.name}
                        {t.ready ? "" : " (no cost profile)"}
                      </option>
                    ))}
                  </select>
                </Fld>
                {money("rate", "Agreed rate ($)")}
                {money("fuelSurcharge", "Fuel surcharge ($)", { hint: "Dollars on the load, if it is paid on top." })}
                {money("loadedMiles", "Loaded miles")}
                {money("emptyToPickup", "Empty to the pickup (mi)")}
                {money("emptyHome", "Empty home (mi)")}
              </div>
            </>
          ) : null}
          <h3 className="th-group">Who it is for</h3>
          <div className="rc-grid">
            {text("brokerName", "Customer", { hint: "A broker, shipper or direct customer." })}
            <Fld label="MC number (brokers and carriers)" error={errors.brokerMc} hint="Leave blank for a shipper or direct customer.">
              <input
                value={v.brokerMc}
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={errors.brokerMc ? true : undefined}
                onChange={(e) => {
                  authority.reset();
                  set({ brokerMc: e.target.value });
                }}
                onBlur={() => void authority.check(v.brokerMc, v.brokerName, (name) => setV((s) => (s.brokerName.trim() === "" ? { ...s, brokerName: name } : s)))}
              />
              <AuthorityStatus busy={authority.busy} result={authority.result} />
            </Fld>
            {text("loadNumber", "Load number")}
            {text("brokerPhone", "Customer phone", { inputMode: "tel" })}
            {text("brokerEmail", "Customer email", { inputMode: "email", hint: "Where the invoice and a reminder go." })}
            {text("poNumber", "PO number")}
          </div>

          <h3 className="th-group">The freight</h3>
          <div className="rc-grid">
            <Fld label="Trailer" error={errors.trailer}>
              <select value={v.trailer} onChange={(e) => set({ trailer: e.target.value })}>
                <option value="">Not stated</option>
                {TRAILER_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Fld>
            {text("weightLbs", "Weight (lb)", { inputMode: "numeric" })}
            {text("hazmat", "Hazmat class")}
            {text("lengthFt", "Length (ft)", { inputMode: "decimal" })}
            {text("widthFt", "Width (ft)", { inputMode: "decimal" })}
            {text("heightIn", "Height (in)", { inputMode: "decimal" })}
          </div>
          <div className="le-checks">
            <label className="dlg-check">
              <input type="checkbox" checked={v.liftgate} onChange={(e) => set({ liftgate: e.target.checked })} /> Needs a liftgate
            </label>
            <label className="dlg-check">
              <input type="checkbox" checked={v.ramp} onChange={(e) => set({ ramp: e.target.checked })} /> Needs a ramp
            </label>
            <label className="dlg-check">
              <input type="checkbox" checked={v.palletJack} onChange={(e) => set({ palletJack: e.target.checked })} /> Needs a pallet jack
            </label>
          </div>
          <div className="rc-grid" style={{ marginTop: 12 }}>
            {text("payTermsDays", "Pay terms (days)", { inputMode: "numeric" })}
          </div>
          <Fld label="Notes" error={errors.notes}>
            <textarea value={v.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Anything the next person on this load should know" />
          </Fld>

          <h3 className="th-group">Stops</h3>
          {scheduleLocked ? <p className="tl-note" style={{ marginBottom: 8 }}>This load has started, so where and when its stops are cannot change. The rest can still be corrected.</p> : driverName ? <p className="tl-note" style={{ marginBottom: 8 }}>{driverName} is on this load. If a place or time changes, they confirm it again.</p> : null}
          <ol className="rc-stops">
            {v.stops.map((s, i) => (
              <li key={s.id} className={`rc-stop ${s.role}`}>
                <span className="badge" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="rc-stop-body">
                  <div className="rc-stop-head">
                    <span className={`tl-chip ${s.role === "pickup" ? "info" : "ok"}`}>{s.role === "pickup" ? "Pickup" : "Delivery"}</span>
                  </div>
                  <div className="rc-stop-grid">
                    <Fld label="Address" error={errors[`stop${i}.address`]}>
                      <AddressInput label={`Address for stop ${i + 1}`} value={s.address} disabled={scheduleLocked} onChange={(text) => setStop(i, { address: text })} invalid={!!errors[`stop${i}.address`]} />
                    </Fld>
                    <Fld label="Opens (Dallas time)" error={errors[`stop${i}.earliest`]}>
                      <input type="datetime-local" value={s.earliest} disabled={scheduleLocked} onChange={(e) => setStop(i, { earliest: e.target.value })} />
                    </Fld>
                    <Fld label="Closes" error={errors[`stop${i}.latest`]}>
                      <input type="datetime-local" value={s.latest} disabled={scheduleLocked} onChange={(e) => setStop(i, { latest: e.target.value })} />
                    </Fld>
                    <Fld label="Facility" error={errors[`stop${i}.facility`]}>
                      <input value={s.facility} onChange={(e) => setStop(i, { facility: e.target.value })} autoComplete="off" />
                    </Fld>
                    <Fld label="Reference numbers" error={errors[`stop${i}.refs`]} hint="Separate with commas.">
                      <input value={s.refs} onChange={(e) => setStop(i, { refs: e.target.value })} autoComplete="off" />
                    </Fld>
                    <Fld label="Contact" error={errors[`stop${i}.contactName`]}>
                      <input value={s.contactName} onChange={(e) => setStop(i, { contactName: e.target.value })} autoComplete="off" />
                    </Fld>
                    <Fld label="Contact phone" error={errors[`stop${i}.contactPhone`]}>
                      <input value={s.contactPhone} inputMode="tel" onChange={(e) => setStop(i, { contactPhone: e.target.value })} autoComplete="off" />
                    </Fld>
                    <Fld label="Notes for this stop" error={errors[`stop${i}.notes`]}>
                      <input value={s.notes} onChange={(e) => setStop(i, { notes: e.target.value })} autoComplete="off" />
                    </Fld>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Modal>
    </>
  );
}

// ── Enter the trip for the driver ──────────────────────────────────────────────────────────────

export type TripStop = { id: string; sequence: number; role: string; place: string; arrivedLocal: string; waitMinutes: string; seal: string };

/**
 * What the driver did, entered by the desk: the pickup (arrival, wait, seal), the delivery (arrival and wait at each stop, when, proof of
 * delivery or why there is none, what it cost) and the expenses on their own. Everything is audited as entered for the driver.
 */
export function TripEntry({
  loadId,
  status,
  assignmentStatus,
  driverName,
  stops,
  expenses,
  delivered,
  pod
}: {
  loadId: string;
  status: string;
  assignmentStatus: string | null;
  driverName: string | null;
  stops: TripStop[];
  expenses: ExpenseValues;
  delivered: string;
  pod: { note: string; without: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = React.useState<null | "start" | "complete" | "expenses">(null);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Errors>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [start, setStart] = React.useState<StartValues>({ arrivedAt: "", waitMinutes: "", seal: "" });
  const [done, setDone] = React.useState<CompleteValues>({ stops: [], deliveredAt: "", pod: "received", podNote: "", fuel: "", tolls: "", misc: "" });
  const [spent, setSpent] = React.useState<ExpenseValues>(expenses);

  const canStart = status === "accepted" && assignmentStatus === "accepted";
  const canComplete = status === "in_progress";
  const canExpense = status === "in_progress" || status === "completed";
  const later = stops.slice(1);

  function open(next: "start" | "complete" | "expenses") {
    setErrors({});
    setMessage(null);
    if (next === "start") setStart({ arrivedAt: nowLocal(), waitMinutes: "", seal: "" });
    if (next === "complete") setDone({ stops: later.map((s) => ({ id: s.id, arrivedAt: s.arrivedLocal, waitMinutes: s.waitMinutes })), deliveredAt: nowLocal(), pod: "received", podNote: "", fuel: expenses.fuel, tolls: expenses.tolls, misc: expenses.misc });
    if (next === "expenses") setSpent(expenses);
    setMode(next);
  }

  async function run<T extends { ok: boolean; error?: string; errors?: Errors }>(call: () => Promise<T>, success: string) {
    setBusy(true);
    const out = await call();
    setBusy(false);
    if (out.ok) {
      setMode(null);
      toast({ text: success, tone: "ok" });
      router.refresh();
    } else {
      setErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked.");
    }
  }

  const has = stops.some((s) => s.arrivedLocal || s.waitMinutes || s.seal);
  const spentTotal = ["fuel", "tolls", "misc"].reduce((t, k) => t + (Number(expenses[k as keyof ExpenseValues]) || 0), 0);

  return (
    <>
      {has || delivered || spentTotal > 0 || pod.note ? (
        <table className="tl-table" style={{ marginBottom: 12 }} aria-label="Stops">
          <thead>
            <tr>
              <th>Stop</th>
              <th>Arrived</th>
              <th className="num">Waited</th>
              <th>Seal</th>
            </tr>
          </thead>
          <tbody>
            {stops.map((s) => (
              <tr key={s.id}>
                <td style={{ textTransform: "capitalize" }}>
                  {s.sequence}. {s.role}
                  <div className="tl-sub">{s.place}</div>
                </td>
                <td>{s.arrivedLocal ? s.arrivedLocal.replace("T", " ") : <span className="dim">—</span>}</td>
                <td className="num">{s.waitMinutes ? `${s.waitMinutes} min` : <span className="dim">—</span>}</td>
                <td>{s.seal || <span className="dim">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="tl-note" style={{ marginBottom: 12 }}>Nothing recorded for the trip yet.</p>
      )}
      {delivered || pod.note || pod.without ? (
        <dl className="tl-kv" style={{ marginBottom: 12 }}>
          {delivered ? (
            <>
              <dt>Delivered</dt>
              <dd>{delivered.replace("T", " ")} Dallas time</dd>
            </>
          ) : null}
          <dt>Proof of delivery</dt>
          <dd>{pod.without ? `None: ${pod.note}` : pod.note || (delivered ? "Received" : "—")}</dd>
          <dt>Expenses</dt>
          <dd>{spentTotal > 0 ? `${usd(spentTotal, 2)} (fuel ${usd(Number(expenses.fuel) || 0, 2)}, tolls ${usd(Number(expenses.tolls) || 0, 2)}, other ${usd(Number(expenses.misc) || 0, 2)})` : "None entered"}</dd>
        </dl>
      ) : null}
      <div className="dlg-row">
        {canStart ? (
          <button type="button" className="tl-btn sm primary" onClick={() => open("start")}>
            Enter the pickup
          </button>
        ) : null}
        {canComplete ? (
          <button type="button" className="tl-btn sm primary" onClick={() => open("complete")}>
            Enter the delivery
          </button>
        ) : null}
        {canExpense ? (
          <button type="button" className="tl-btn sm" onClick={() => open("expenses")}>
            {spentTotal > 0 ? "Change expenses" : "Enter expenses"}
          </button>
        ) : null}
        {!canStart && !canComplete && !canExpense ? <span className="tl-sub">{status === "completed" ? "" : assignmentStatus === "accepted" ? "" : "The driver has to accept the load before their trip can be entered."}</span> : null}
      </div>

      <Modal
        open={mode === "start"}
        onClose={() => setMode(null)}
        eyebrow="Entered for the driver"
        title={`${driverName ?? "The driver"} picked up`}
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setMode(null)}>
              Back
            </button>
            <button
              type="button"
              className="tl-btn primary"
              disabled={busy}
              onClick={() => {
                const c = validateStart(start);
                if (!c.ok) return setErrors(c.errors);
                void run(() => startTripAction(loadId, start), "Picked up. The load is on the road.");
              }}>
              Record the pickup
            </button>
          </>
        }>
        <div className="dlg-form">
          <p className="tl-note">The load goes on the road. Times are Dallas time, and are what has already happened.</p>
          <Fld label="Arrived at the pickup" error={errors.arrivedAt}>
            <input type="datetime-local" value={start.arrivedAt} onChange={(e) => setStart({ ...start, arrivedAt: e.target.value })} />
          </Fld>
          <div className="dlg-two">
            <Fld label="Waited (minutes)" error={errors.waitMinutes}>
              <input inputMode="numeric" value={start.waitMinutes} onChange={(e) => setStart({ ...start, waitMinutes: e.target.value })} />
            </Fld>
            <Fld label="Seal number" error={errors.seal}>
              <input value={start.seal} onChange={(e) => setStart({ ...start, seal: e.target.value })} autoComplete="off" />
            </Fld>
          </div>
        </div>
      </Modal>

      <Modal
        wide
        open={mode === "complete"}
        onClose={() => setMode(null)}
        eyebrow="Entered for the driver"
        title={`${driverName ?? "The driver"} delivered`}
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setMode(null)}>
              Back
            </button>
            <button
              type="button"
              className="tl-btn primary"
              disabled={busy}
              onClick={() => {
                const c = validateComplete(done);
                if (!c.ok) return setErrors(c.errors);
                void run(() => completeTripAction(loadId, done), "Delivered. It is ready to invoice.");
              }}>
              Record the delivery
            </button>
          </>
        }>
        <div className="dlg-form">
          {later.map((s, i) => (
            <div key={s.id} className="dlg-two">
              <Fld label={`Arrived at stop ${s.sequence} (${s.role})`} error={errors[`stop${i}.arrivedAt`]}>
                <input type="datetime-local" value={done.stops[i]?.arrivedAt ?? ""} onChange={(e) => setDone({ ...done, stops: done.stops.map((x, k) => (k === i ? { ...x, arrivedAt: e.target.value } : x)) })} />
              </Fld>
              <Fld label="Waited (minutes)" error={errors[`stop${i}.waitMinutes`]}>
                <input inputMode="numeric" value={done.stops[i]?.waitMinutes ?? ""} onChange={(e) => setDone({ ...done, stops: done.stops.map((x, k) => (k === i ? { ...x, waitMinutes: e.target.value } : x)) })} />
              </Fld>
            </div>
          ))}
          <Fld label="Delivered at" error={errors.deliveredAt}>
            <input type="datetime-local" value={done.deliveredAt} onChange={(e) => setDone({ ...done, deliveredAt: e.target.value })} />
          </Fld>
          <div role="radiogroup" aria-label="Proof of delivery" className="le-checks">
            <label className="dlg-check">
              <input type="radio" name="pod" checked={done.pod === "received"} onChange={() => setDone({ ...done, pod: "received" })} /> Proof of delivery received
            </label>
            <label className="dlg-check">
              <input type="radio" name="pod" checked={done.pod === "none"} onChange={() => setDone({ ...done, pod: "none" })} /> None, and here is why
            </label>
          </div>
          <Fld label={done.pod === "none" ? "Why there is no proof of delivery" : "What it is and where it is (optional)"} error={errors.podNote} hint={done.pod === "received" ? "For example: signed BOL emailed on delivery. The file itself waits for the phone's storage." : undefined}>
            <input value={done.podNote} onChange={(e) => setDone({ ...done, podNote: e.target.value })} autoComplete="off" />
          </Fld>
          <div className="rc-grid">
            <Fld label="Fuel ($)" error={errors.fuel}>
              <input inputMode="decimal" value={done.fuel} onChange={(e) => setDone({ ...done, fuel: e.target.value })} />
            </Fld>
            <Fld label="Tolls ($)" error={errors.tolls}>
              <input inputMode="decimal" value={done.tolls} onChange={(e) => setDone({ ...done, tolls: e.target.value })} />
            </Fld>
            <Fld label="Other ($)" error={errors.misc}>
              <input inputMode="decimal" value={done.misc} onChange={(e) => setDone({ ...done, misc: e.target.value })} />
            </Fld>
          </div>
        </div>
      </Modal>

      <Modal
        open={mode === "expenses"}
        onClose={() => setMode(null)}
        eyebrow="Expenses"
        title="What the trip cost"
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setMode(null)}>
              Back
            </button>
            <button
              type="button"
              className="tl-btn primary"
              disabled={busy}
              onClick={() => {
                const c = validateExpenses(spent);
                if (!c.ok) return setErrors(c.errors);
                void run(() => saveExpensesAction(loadId, spent), "Expenses saved.");
              }}>
              Save expenses
            </button>
          </>
        }>
        <div className="dlg-form">
          <Fld label="Fuel ($)" error={errors.fuel}>
            <input inputMode="decimal" value={spent.fuel} onChange={(e) => setSpent({ ...spent, fuel: e.target.value })} />
          </Fld>
          <Fld label="Tolls ($)" error={errors.tolls}>
            <input inputMode="decimal" value={spent.tolls} onChange={(e) => setSpent({ ...spent, tolls: e.target.value })} />
          </Fld>
          <Fld label="Other ($)" error={errors.misc}>
            <input inputMode="decimal" value={spent.misc} onChange={(e) => setSpent({ ...spent, misc: e.target.value })} />
          </Fld>
        </div>
      </Modal>
    </>
  );
}

// ── Bill a delivered load ──────────────────────────────────────────────────────────────────────

/** Create the invoice: its number and terms, the extra charges to put on it, and the total as you type. Nothing goes out; it is recorded and can be printed. */
export function InvoiceDialog({
  loadId,
  loadNumber,
  defaults,
  context,
  blockers,
  cautions,
  size = "primary"
}: {
  loadId: string;
  loadNumber: string;
  defaults: { number: string };
  context: InvoiceContext;
  blockers: string[];
  cautions: string[];
  size?: "primary" | "sm";
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState<InvoiceForm>({ number: defaults.number, terms: "", detention: context.detention > 0, lumper: "", layover: "", otherLabel: "", other: "" });
  const [errors, setErrors] = React.useState<Errors>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const preview = validateInvoice(f, context);

  async function create() {
    const c = validateInvoice(f, context);
    if (!c.ok) {
      setErrors(c.errors);
      return;
    }
    setBusy(true);
    const out = await invoiceLoadAction(loadId, f);
    setBusy(false);
    if (out.ok) {
      setOpen(false);
      toast({ text: `${f.number} created for ${usd(out.total ?? 0, 2)}.`, tone: "ok" });
      router.refresh();
    } else {
      setErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked.");
    }
  }

  return (
    <>
      <button type="button" className={`tl-btn ${size === "sm" ? "sm primary" : "primary"}`} onClick={() => setOpen(true)}>
        Create invoice
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={loadNumber}
        title="Create the invoice"
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy || blockers.length > 0} onClick={() => void create()}>
              Create invoice
            </button>
          </>
        }>
        <div className="dlg-form">
          {blockers.map((b) => (
            <p key={b} className="tl-note warn" role="alert">
              {b}
            </p>
          ))}
          {cautions.map((c) => (
            <p key={c} className="tl-note">
              {c}
            </p>
          ))}
          <div className="dlg-two">
            <Fld label="Invoice number" error={errors.number}>
              <input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} autoComplete="off" />
            </Fld>
            <Fld label="Pay terms (days)" error={errors.terms} hint={`Blank uses ${context.defaultTerms}.`}>
              <input inputMode="numeric" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} />
            </Fld>
          </div>
          {context.detention > 0 ? (
            <label className="dlg-check">
              <input type="checkbox" checked={f.detention} onChange={(e) => setF({ ...f, detention: e.target.checked })} /> Add {usd(context.detention, 2)} of detention
            </label>
          ) : null}
          <div className="dlg-two">
            <Fld label="Lumper ($)" error={errors.lumper}>
              <input inputMode="decimal" value={f.lumper} onChange={(e) => setF({ ...f, lumper: e.target.value })} />
            </Fld>
            <Fld label="Layover ($)" error={errors.layover}>
              <input inputMode="decimal" value={f.layover} onChange={(e) => setF({ ...f, layover: e.target.value })} />
            </Fld>
          </div>
          <div className="dlg-two">
            <Fld label="Another charge, for" error={errors.otherLabel}>
              <input value={f.otherLabel} onChange={(e) => setF({ ...f, otherLabel: e.target.value })} autoComplete="off" />
            </Fld>
            <Fld label="Amount ($)" error={errors.other}>
              <input inputMode="decimal" value={f.other} onChange={(e) => setF({ ...f, other: e.target.value })} />
            </Fld>
          </div>
          <dl className="rc-facts">
            {preview.ok
              ? preview.value.lines.map((l) => (
                  <div key={l.label}>
                    <dt>{l.label}</dt>
                    <dd>{usd(l.amount, 2)}</dd>
                  </div>
                ))
              : null}
            <div>
              <dt>
                <b>Total due</b>
              </dt>
              <dd>
                <b>{preview.ok ? usd(preview.value.total, 2) : "—"}</b>
              </dd>
            </div>
          </dl>
        </div>
      </Modal>
    </>
  );
}

// ── Payment ────────────────────────────────────────────────────────────────────────────────────

/** Mark an invoice paid with what came in. A payment that is not the invoice total is recorded as it came, and says by how much it differs. */
export function PaidDialog({ loadId, invoiceNumber, billed, size = "primary" }: { loadId: string; invoiceNumber: string | null; billed: number; size?: "primary" | "sm" }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState(billed.toFixed(2));
  const [paidOn, setPaidOn] = React.useState(() => nowLocal().slice(0, 10));
  const [method, setMethod] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const typed = Number(amount.replace(/,/g, ""));
  const diff = Number.isFinite(typed) ? Math.round((typed - billed) * 100) / 100 : 0;

  async function pay() {
    setBusy(true);
    const out = await paidAction(loadId, amount, paidOn, method);
    setBusy(false);
    if (out.ok) {
      setOpen(false);
      toast({ text: out.difference ? `Paid, $${Math.abs(out.difference).toFixed(2)} ${out.difference < 0 ? "short" : "over"}.` : "Marked paid.", tone: out.difference && out.difference < 0 ? "bad" : "ok" });
      router.refresh();
    } else setMessage(out.error ?? "That could not be recorded.");
  }

  return (
    <>
      <button
        type="button"
        className={`tl-btn ${size === "sm" ? "sm" : "primary"}`}
        onClick={() => {
          setAmount(billed.toFixed(2));
          setPaidOn(nowLocal().slice(0, 10));
          setMethod("");
          setMessage(null);
          setOpen(true);
        }}>
        Mark paid
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={invoiceNumber ?? "Invoice"}
        title="What came in?"
        footer={
          <>
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy} onClick={() => void pay()}>
              Record the payment
            </button>
          </>
        }>
        <div className="dlg-form">
          <Fld label="Amount received ($)" error={message ?? undefined} hint={`The invoice is ${usd(billed, 2)}.`}>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Fld>
          <div className="dlg-two">
            <Fld label="Paid on" hint="Dallas date. Change it to enter an earlier payment.">
              <input type="date" value={paidOn} max={nowLocal().slice(0, 10)} onChange={(e) => setPaidOn(e.target.value)} />
            </Fld>
            <Fld label="How" hint="Optional.">
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">Not recorded</option>
                {PAID_METHODS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Fld>
          </div>
          {diff < 0 ? <p className="tl-note warn">That is {usd(Math.abs(diff), 2)} short of the invoice. It is recorded as a short payment, and the invoice shows it.</p> : diff > 0 ? <p className="tl-note">That is {usd(diff, 2)} more than the invoice.</p> : null}
        </div>
      </Modal>
    </>
  );
}
