"use client";

import { useRouter } from "next/navigation";
import { TruckPicker } from "./truck-picker";
import React from "react";
import { completeTripAction, correctTripAction, invoiceLoadAction, paidAction, saveExpensesAction, saveLoadDetailsAction, startTripAction } from "@/app/(desk)/actions";
import { shortDate, usd } from "@/lib/desk-format";
import { termsLabel, validateInvoice, type InvoiceContext, type InvoiceForm } from "@/lib/invoicing";
import { dueAt } from "@/lib/overdue";
import { validateLoadEdit, type DealValues, type EditStopValues, type LoadEditValues } from "@/lib/load-edit";
import { EXPENSE_ITEMS, validateComplete, validateCorrection, validateExpenses, validateStart, type CompleteValues, type CorrectValues, type ExpenseValues, type StartValues } from "@/lib/trip";
import { toCentralLocal } from "@/lib/zoned";
import { TRAILER_TYPES } from "@/truelane/constants/trailerData";
import { AddressInput } from "./address-input";
import { PAID_METHODS } from "@/lib/pay-method";
import { AuthorityStatus, useAuthorityLookup } from "./customer-authority";
import { Modal } from "./kit/modal";
import { FuelImport } from "./partner-actions";
import { useToast } from "./kit/toast";
import { DraftNote, useDraft } from "./kit/use-draft";
import { tried } from "./kit/tried";
import { DateInput } from "./date-input";

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


/**
 * The rest of what a trip cost and drove, shared by the delivery and the expenses dialogs: the itemised costs (their total is kept with "other"), the insurance rider, a note on why the
 * money is what it is, the miles actually driven (the quoted miles are kept beside them), and whether a load covers the way home.
 */
function TripExtras<T extends ExpenseValues>({ v, set, errors, tonu }: { v: T; set: (patch: Partial<ExpenseValues>) => void; errors: Errors; tonu?: boolean }) {
  const items = v.items ?? {};
  const miles = v.miles ?? { pickup: "", loaded: "", home: "" };
  return (
    <>
      <details className="dlg-more" open={EXPENSE_ITEMS.some((i) => (items[i.key] ?? "") !== "")}>
        <summary>Itemised costs: lumper, scale, parking, lodging, wash, maintenance, permits, supplies</summary>
        <div className="rc-grid">
          {EXPENSE_ITEMS.map((i) => (
            <Fld key={i.key} label={`${i.label} ($)`} error={errors[`item.${i.key}`]}>
              <input inputMode="decimal" value={items[i.key] ?? ""} onChange={(e) => set({ items: { ...items, [i.key]: e.target.value } })} />
            </Fld>
          ))}
        </div>
      </details>
      <div className="rc-grid">
        <Fld label="Insurance rider ($)" error={errors.rider} hint="A rider bought for this load. Blank keeps what it has.">
          <input inputMode="decimal" value={v.rider ?? ""} onChange={(e) => set({ rider: e.target.value })} />
        </Fld>
        <Fld label="Note on the revenue" error={errors.revenueNote} hint="Why it is what it is: a short pay, a detention the customer agreed to.">
          <input value={v.revenueNote ?? ""} onChange={(e) => set({ revenueNote: e.target.value })} autoComplete="off" />
        </Fld>
      </div>
      {tonu ? (
        <Fld label="Miles driven for the TONU" error={errors.tonuMiles} hint="The truck went and the load was not ready. These are costs the TONU fee has to cover.">
          <input inputMode="decimal" value={v.tonuMiles ?? ""} onChange={(e) => set({ tonuMiles: e.target.value })} />
        </Fld>
      ) : null}
      {tonu ? null : (
      <>
      <div className="rc-grid">
        <Fld label="Miles empty to pickup" error={errors["miles.pickup"]}>
          <input inputMode="decimal" value={miles.pickup} onChange={(e) => set({ miles: { ...miles, pickup: e.target.value } })} />
        </Fld>
        <Fld label="Loaded miles" error={errors["miles.loaded"]}>
          <input inputMode="decimal" value={miles.loaded} onChange={(e) => set({ miles: { ...miles, loaded: e.target.value } })} />
        </Fld>
        <Fld label="Miles empty home" error={errors["miles.home"]}>
          <input inputMode="decimal" value={miles.home} onChange={(e) => set({ miles: { ...miles, home: e.target.value } })} />
        </Fld>
      </div>
      <p className="tl-note" style={{ margin: 0 }}>The miles actually driven replace the quoted ones in every per-mile figure; the quote&apos;s miles are kept to show the difference.</p>
      <label className="dlg-check">
        <input type="checkbox" checked={v.backhaul === true} onChange={(e) => set({ backhaul: e.target.checked })} /> A load covers the way home
      </label>
      </>
      )}
    </>
  );
}

const nowLocal = () => toCentralLocal(Date.now());

// ── Edit a load ────────────────────────────────────────────────────────────────────────────────

/**
 * Change what a load says: who it is for, its numbers, weight and size, what it needs, notes, and each stop's place, times, references and
 * contact. A load that has started keeps its stops where they are (its details can still be corrected). A driver who already has it is asked to
 * confirm again if a place or time changes.
 */
export function LoadEditDialog({ loadId, loadNumber, initial, scheduleLocked, driverName, truckName, dealLocked }: { loadId: string; loadNumber: string; initial: LoadEditValues; scheduleLocked: boolean; driverName: string | null; truckName: string | null; dealLocked: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [v, setV, kept] = useDraft<LoadEditValues>(`load-edit:${loadId}`, initial);
  const [errors, setErrors] = React.useState<Errors>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
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
    const got = await tried(() => saveLoadDetailsAction(loadId, v));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (out.ok) {
      kept.saved();
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
          <DraftNote draft={kept} what="this load" />
          {v.deal ? (
            <>
              <h3 className="th-group">The deal</h3>
              {dealLocked ? <p className="tl-note" style={{ marginBottom: 8 }}>{dealLocked}</p> : null}
              <div className="rc-grid">
                <Fld label="Truck" error={errors["deal.vehicleId"]} hint={!dealLocked && scheduleLocked ? "A load that has started keeps its truck." : undefined}>
                  <TruckPicker
                    id={v.deal.vehicleId}
                    name={truckName ?? ""}
                    readyOnly
                    label="Truck"
                    disabled={dealLocked != null || scheduleLocked}
                    invalid={v.deal.vehicleId === "?" || (initial.deal?.vehicleId !== "" && v.deal.vehicleId === "")}
                    onPick={(id) => setDeal({ vehicleId: id })}
                  />
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
                      <DateInput type="datetime-local" value={s.earliest} disabled={scheduleLocked} onChange={(e) => setStop(i, { earliest: e.target.value })} />
                    </Fld>
                    <Fld label="Closes" error={errors[`stop${i}.latest`]}>
                      <DateInput type="datetime-local" value={s.latest} disabled={scheduleLocked} onChange={(e) => setStop(i, { latest: e.target.value })} />
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

/** `opensLocal` is when the stop window opens (Dallas time), for the early-arrival advisory. */
export type TripStop = { id: string; sequence: number; role: string; place: string; arrivedLocal: string; waitMinutes: string; seal: string; opensLocal?: string };

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
  pod,
  quoted,
  terms,
  canDispatch = true
}: {
  loadId: string;
  status: string;
  assignmentStatus: string | null;
  driverName: string | null;
  stops: TripStop[];
  expenses: ExpenseValues;
  delivered: string;
  pod: { note: string; without: boolean };
  /** The rate on the load, as typed in the box: shown as the default of the linehaul actually paid. */
  quoted: string;
  /** The detention terms this load is held to now (its own, else the truck profile), as typed in the boxes. */
  terms?: { rate: string; grace: string };
  /** Whether this person enters the pickup and the delivery (a dispatcher does; the accounting office only corrects figures). */
  canDispatch?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = React.useState<null | "start" | "complete" | "expenses" | "correct">(null);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Errors>({});
  const [message, setMessage] = React.useState<string | null>(null);
  // What is typed for the driver is kept until it is saved: leaving the load or refreshing does not lose it.
  const [start, setStart, startDraft] = useDraft<StartValues>(`trip-start:${loadId}`, { arrivedAt: "", waitMinutes: "", seal: "" });
  const [done, setDone, doneDraft] = useDraft<CompleteValues>(`trip-done:${loadId}`, { stops: [], deliveredAt: "", pod: "received", podNote: "", fuel: "", tolls: "", misc: "", layover: "", actualRevenue: "" });
  const [fix, setFix, fixDraft] = useDraft<CorrectValues>(`trip-correct:${loadId}`, { stops: [], detentionRate: "", detentionGraceMinutes: "", reason: "" });
  const [spent, setSpent, spentDraft] = useDraft<ExpenseValues>(`trip-spent:${loadId}`, expenses);

  const canStart = status === "accepted" && assignmentStatus === "accepted";
  const canComplete = status === "in_progress";
  const canExpense = status === "in_progress" || status === "completed" || status === "tonu";
  const later = stops.slice(1);

  function open(next: "start" | "complete" | "expenses" | "correct") {
    setErrors({});
    setMessage(null);
    // The starting figures go in only when nothing has been typed; what was typed stays.
    if (next === "start" && start.arrivedAt === "" && start.waitMinutes === "" && start.seal === "") setStart({ arrivedAt: nowLocal(), waitMinutes: "", seal: "" });
    if (next === "complete" && done.deliveredAt === "") setDone({ stops: later.map((s) => ({ id: s.id, arrivedAt: s.arrivedLocal, waitMinutes: s.waitMinutes, seal: s.seal })), deliveredAt: nowLocal(), pod: "received", podNote: "", fuel: expenses.fuel, tolls: expenses.tolls, misc: expenses.misc, layover: expenses.layover ?? "", items: expenses.items, rider: expenses.rider, revenueNote: expenses.revenueNote, miles: expenses.miles, backhaul: expenses.backhaul, actualRevenue: "" });
    // A correction starts from what is recorded; a draft kept for other stops (the load changed) is not used.
    if (next === "correct" && (fix.stops.length !== stops.length || fix.stops.some((s, i) => s.id !== stops[i]?.id))) setFix({ stops: stops.map((s) => ({ id: s.id, arrivedAt: s.arrivedLocal, waitMinutes: s.waitMinutes, seal: s.seal })), detentionRate: "", detentionGraceMinutes: "", reason: "" });
    setMode(next);
  }

  async function run<T extends { ok: boolean; error?: string; errors?: Errors }>(call: () => Promise<T>, success: string, kept: { saved: () => void }) {
    setBusy(true);
    const got = await tried(call);
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (out.ok) {
      kept.saved();
      setMode(null);
      toast({ text: success, tone: "ok" });
      router.refresh();
    } else {
      setErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked.");
    }
  }

  const has = stops.some((s) => s.arrivedLocal || s.waitMinutes || s.seal);
  const itemisedTotal = EXPENSE_ITEMS.reduce((t, i) => t + (Number(expenses.items?.[i.key]) || 0), 0);
  const spentTotal = ["fuel", "tolls", "misc"].reduce((t, k) => t + (Number(expenses[k as "fuel" | "tolls" | "misc"]) || 0), 0) + itemisedTotal;

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
          <dd>{spentTotal > 0 ? `${usd(spentTotal, 2)} (fuel ${usd(Number(expenses.fuel) || 0, 2)}, tolls ${usd(Number(expenses.tolls) || 0, 2)}, other ${usd((Number(expenses.misc) || 0) + itemisedTotal, 2)})` : "None entered"}</dd>
          {Number(expenses.layover) > 0 ? (
            <>
              <dt>Layover pay</dt>
              <dd>{usd(Number(expenses.layover), 2)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <div className="dlg-row">
        {canStart && canDispatch ? (
          <button type="button" className="tl-btn sm primary" onClick={() => open("start")}>
            Enter the pickup
          </button>
        ) : null}
        {canComplete && canDispatch ? (
          <button type="button" className="tl-btn sm primary" onClick={() => open("complete")}>
            Enter the delivery
          </button>
        ) : null}
        {canComplete || status === "completed" ? (
          <button type="button" className="tl-btn sm" onClick={() => open("correct")}>
            Correct waits and seals
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
                void run(() => startTripAction(loadId, start), "Picked up. The load is on the road.", startDraft);
              }}>
              Record the pickup
            </button>
          </>
        }>
        <div className="dlg-form">
          <p className="tl-note">The load goes on the road. Times are Dallas time, and are what has already happened.</p>
          <Fld label="Arrived at the pickup" error={errors.arrivedAt}>
            <DateInput type="datetime-local" value={start.arrivedAt} onChange={(e) => setStart({ ...start, arrivedAt: e.target.value })} />
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
                void run(() => completeTripAction(loadId, done), "Delivered. It is ready to invoice.", doneDraft);
              }}>
              Record the delivery
            </button>
          </>
        }>
        <div className="dlg-form">
          {later.map((s, i) => (
            <div key={s.id} className="dlg-two">
              <Fld label={`Arrived at stop ${s.sequence} (${s.role})`} error={errors[`stop${i}.arrivedAt`]}>
                <DateInput type="datetime-local" value={done.stops[i]?.arrivedAt ?? ""} onChange={(e) => setDone({ ...done, stops: done.stops.map((x, k) => (k === i ? { ...x, arrivedAt: e.target.value } : x)) })} />
              </Fld>
              <Fld label="Waited (minutes)" error={errors[`stop${i}.waitMinutes`]}>
                <input inputMode="numeric" value={done.stops[i]?.waitMinutes ?? ""} onChange={(e) => setDone({ ...done, stops: done.stops.map((x, k) => (k === i ? { ...x, waitMinutes: e.target.value } : x)) })} />
              </Fld>
              <Fld label={`Seal at stop ${s.sequence} (optional)`} error={errors[`stop${i}.seal`]}>
                <input value={done.stops[i]?.seal ?? ""} onChange={(e) => setDone({ ...done, stops: done.stops.map((x, k) => (k === i ? { ...x, seal: e.target.value } : x)) })} autoComplete="off" />
              </Fld>
            </div>
          ))}
          <Fld label="Delivered at" error={errors.deliveredAt}>
            <DateInput type="datetime-local" value={done.deliveredAt} onChange={(e) => setDone({ ...done, deliveredAt: e.target.value })} />
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
          <Fld label="Linehaul actually paid ($)" error={errors.actualRevenue} hint={`Leave blank when it is the rate on the load${quoted ? ` ($${quoted})` : ""}. Type the amount when the customer paid a different linehaul: a short pay or an adjusted rate. It becomes what the load earned and what the invoice starts from.`}>
            <input inputMode="decimal" value={done.actualRevenue ?? ""} onChange={(e) => setDone({ ...done, actualRevenue: e.target.value })} placeholder={quoted} />
          </Fld>
          <div className="rc-grid">
            <Fld label="Fuel ($)" error={errors.fuel}>
              <input inputMode="decimal" value={done.fuel} onChange={(e) => setDone({ ...done, fuel: e.target.value })} />
              <FuelImport loadId={loadId} current={done.fuel} onFill={(v) => setDone((d) => ({ ...d, fuel: d.fuel.trim() === "" ? v : d.fuel }))} />
            </Fld>
            <Fld label="Tolls ($)" error={errors.tolls}>
              <input inputMode="decimal" value={done.tolls} onChange={(e) => setDone({ ...done, tolls: e.target.value })} />
            </Fld>
            <Fld label="Layover pay received ($)" error={errors.layover} hint="Paid by the customer for waiting overnight. It is revenue, not a cost.">
              <input inputMode="decimal" value={done.layover ?? ""} onChange={(e) => setDone({ ...done, layover: e.target.value })} />
            </Fld>
            <Fld label="Other ($)" error={errors.misc}>
              <input inputMode="decimal" value={done.misc} onChange={(e) => setDone({ ...done, misc: e.target.value })} />
            </Fld>
          </div>
          <TripExtras v={done} set={(p) => setDone((d) => ({ ...d, ...p }))} errors={errors} />
        </div>
      </Modal>

      <Modal
        open={mode === "correct"}
        onClose={() => setMode(null)}
        eyebrow="Correct the record"
        title="Arrivals, waits and seals"
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
                const c = validateCorrection(fix);
                if (!c.ok) return setErrors(c.errors);
                void run(() => correctTripAction(loadId, fix), "Corrected.", fixDraft);
              }}>
              Save the correction
            </button>
          </>
        }>
        <div className="dlg-form">
          <DraftNote draft={fixDraft} />
          {stops.map((s, i) => {
            const arrived = fix.stops[i]?.arrivedAt ?? "";
            // The wait counts from the appointment when the driver arrived early; say so, so the minutes typed are the ones that count.
            const early = s.opensLocal && arrived && arrived < s.opensLocal ? Math.round((Date.parse(`${s.opensLocal}:00Z`) - Date.parse(`${arrived}:00Z`)) / 60000) : 0;
            return (
              <div key={s.id} className="dlg-two">
                <Fld label={`Arrived at stop ${s.sequence} (${s.role})`} error={errors[`stop${i}.arrivedAt`]} hint={early > 0 ? `${early} min before the window opened. Free time starts when it opens, so the wait to enter is counted from then.` : undefined}>
                  <DateInput type="datetime-local" value={arrived} onChange={(e) => setFix({ ...fix, stops: fix.stops.map((x, k) => (k === i ? { ...x, arrivedAt: e.target.value } : x)) })} />
                </Fld>
                <Fld label="Waited (minutes)" error={errors[`stop${i}.waitMinutes`]}>
                  <input inputMode="numeric" value={fix.stops[i]?.waitMinutes ?? ""} onChange={(e) => setFix({ ...fix, stops: fix.stops.map((x, k) => (k === i ? { ...x, waitMinutes: e.target.value } : x)) })} />
                </Fld>
                <Fld label={`Seal at stop ${s.sequence}`} error={errors[`stop${i}.seal`]}>
                  <input value={fix.stops[i]?.seal ?? ""} onChange={(e) => setFix({ ...fix, stops: fix.stops.map((x, k) => (k === i ? { ...x, seal: e.target.value } : x)) })} autoComplete="off" />
                </Fld>
              </div>
            );
          })}
          <div className="dlg-two">
            <Fld label="Detention rate for this load ($ an hour)" error={errors.detentionRate} hint={terms?.rate ? `Now $${terms.rate}. Blank keeps it. Use it when the rate confirmation says something other than the truck profile.` : "Blank keeps it."}>
              <input inputMode="decimal" value={fix.detentionRate ?? ""} onChange={(e) => setFix({ ...fix, detentionRate: e.target.value })} />
            </Fld>
            <Fld label="Free time for this load (minutes)" error={errors.detentionGraceMinutes} hint={terms?.grace ? `Now ${terms.grace} min. Blank keeps it.` : "Blank keeps it."}>
              <input inputMode="numeric" value={fix.detentionGraceMinutes ?? ""} onChange={(e) => setFix({ ...fix, detentionGraceMinutes: e.target.value })} />
            </Fld>
          </div>
          <Fld label="What was wrong" error={errors.reason} hint="Kept in the record beside the change.">
            <input value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} autoComplete="off" />
          </Fld>
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
                void run(() => saveExpensesAction(loadId, spent), "Expenses saved.", spentDraft);
              }}>
              Save expenses
            </button>
          </>
        }>
        <div className="dlg-form">
          <Fld label="Fuel ($)" error={errors.fuel}>
            <input inputMode="decimal" value={spent.fuel} onChange={(e) => setSpent({ ...spent, fuel: e.target.value })} />
            <FuelImport loadId={loadId} current={spent.fuel} onFill={(v) => setSpent((s) => ({ ...s, fuel: s.fuel.trim() === "" ? v : s.fuel }))} />
          </Fld>
          <Fld label="Tolls ($)" error={errors.tolls}>
            <input inputMode="decimal" value={spent.tolls} onChange={(e) => setSpent({ ...spent, tolls: e.target.value })} />
          </Fld>
          <Fld label="Layover pay received ($)" error={errors.layover} hint="Paid by the customer for waiting overnight. It is revenue, not a cost.">
            <input inputMode="decimal" value={spent.layover ?? ""} onChange={(e) => setSpent({ ...spent, layover: e.target.value })} />
          </Fld>
          <Fld label="Other ($)" error={errors.misc}>
            <input inputMode="decimal" value={spent.misc} onChange={(e) => setSpent({ ...spent, misc: e.target.value })} />
          </Fld>
          <TripExtras v={spent} set={(p) => setSpent((s) => ({ ...s, ...p }))} errors={errors} tonu={status === "tonu"} />
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
  billTo = null,
  size = "primary"
}: {
  loadId: string;
  loadNumber: string;
  defaults: { number: string };
  /** Who the invoice is for, so it is seen before it is made. */
  billTo?: string | null;
  context: InvoiceContext;
  blockers: string[];
  cautions: string[];
  size?: "primary" | "sm";
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [f, setF, kept] = useDraft<InvoiceForm>(`invoice:${loadId}`, { number: defaults.number, terms: "", detention: context.detention > 0, lumper: "", layover: "", otherLabel: "", other: "" });
  const [errors, setErrors] = React.useState<Errors>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const preview = validateInvoice(f, context);

  // The terms in force: the chip or number chosen, else the customer's own, else the desk's. Shown with the day it makes the invoice due.
  const termsDays = f.terms.trim() === "" ? context.defaultTerms : Number(f.terms);
  const dueDay = Number.isInteger(termsDays) && termsDays >= 0 && termsDays <= 120 ? dueAt(new Date(), termsDays) : null;

  async function create() {
    setErrors({});
    setMessage(null);
    const c = validateInvoice(f, context);
    if (!c.ok) {
      setErrors(c.errors);
      return;
    }
    setBusy(true);
    const got = await tried(() => invoiceLoadAction(loadId, f));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (out.ok) {
      kept.saved();
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
      <button
        type="button"
        className={`tl-btn ${size === "sm" ? "sm primary" : "primary"}`}
        onClick={() => {
          setErrors({});
          setMessage(null);
          setOpen(true);
        }}>
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
        <form
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (blockers.length === 0 && !busy) void create();
          }}>
          {billTo ? <p className="tl-note" style={{ margin: 0 }}>Billed to <b>{billTo}</b></p> : null}
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
          <DraftNote draft={kept} what="this invoice" />
          <div className="dlg-two">
            <Fld label="Invoice number" error={errors.number}>
              <input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} autoComplete="off" />
            </Fld>
            <Fld label="Pay terms (days)" error={errors.terms} hint={`${dueDay ? `Due ${shortDate(dueDay)}. ` : ""}Blank uses ${termsLabel(context.defaultTerms)}.`}>
              <input inputMode="numeric" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} />
            </Fld>
          </div>
          <div className="dlg-row" role="group" aria-label="Common terms">
            {[15, 30, 45, 0].map((d) => (
              <button key={d} type="button" className={`tl-btn sm${termsDays === d ? " primary" : ""}`} aria-pressed={termsDays === d} onClick={() => setF({ ...f, terms: String(d) })}>
                {termsLabel(d)}
              </button>
            ))}
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
        </form>
      </Modal>
    </>
  );
}

// ── Payment ────────────────────────────────────────────────────────────────────────────────────

/** Mark an invoice paid with what came in. A payment that is not the invoice total is recorded as it came, and says by how much it differs. */
export function PaidDialog({ loadId, invoiceNumber, billed, owing, canWriteOff = true, size = "primary" }: { loadId: string; invoiceNumber: string | null; billed: number; owing?: number; /** Writing a shortfall off is an admin's: without it the dialog only offers to keep the balance open. */ canWriteOff?: boolean; size?: "primary" | "sm" }) {
  const router = useRouter();
  const toast = useToast();
  // What is still owed: the whole invoice, or what is left of it after part payments.
  const due = owing ?? billed;
  const received = Math.round((billed - due) * 100) / 100;
  const [open, setOpen] = React.useState(false);
  // What is typed is kept until the payment is recorded.
  const [{ amount, paidOn, method, shortAction, shortReason, overAck }, setPaid, draft] = useDraft<{ amount: string; paidOn: string; method: string; shortAction: "balance" | "writeoff"; shortReason: string; overAck: boolean }>(`paid:${loadId}`, {
    amount: due.toFixed(2),
    paidOn: nowLocal().slice(0, 10),
    method: "",
    shortAction: "balance",
    shortReason: "",
    overAck: false
  });
  const setAmount = (v: string) => setPaid((p) => ({ ...p, amount: v }));
  const setPaidOn = (v: string) => setPaid((p) => ({ ...p, paidOn: v }));
  const setMethod = (v: string) => setPaid((p) => ({ ...p, method: v }));
  const setShortAction = (v: "balance" | "writeoff") => setPaid((p) => ({ ...p, shortAction: v }));
  const setShortReason = (v: string) => setPaid((p) => ({ ...p, shortReason: v }));
  const setOverAck = (v: boolean) => setPaid((p) => ({ ...p, overAck: v }));
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Left blank, the amount is what is owed (the server reads it the same way).
  const typed = amount.trim() === "" ? due : Number(amount.replace(/,/g, ""));
  const diff = Number.isFinite(typed) ? Math.round((typed - due) * 100) / 100 : 0;
  // More than is owed closes the invoice as paid over: a stray extra zero is caught by asking for it on purpose.

  async function pay() {
    setMessage(null);
    setBusy(true);
    const got = await tried(() => paidAction(loadId, amount, paidOn, method, shortAction, shortReason));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (out.ok) {
      draft.saved();
      setOpen(false);
      toast(
        out.balance != null
          ? { text: `Part payment recorded. ${usd(out.balance, 2)} is still owed.`, tone: "ok" }
          : { text: out.difference ? `Paid, $${Math.abs(out.difference).toFixed(2)} ${out.difference < 0 ? "written off" : "over"}.` : "Marked paid.", tone: out.difference && out.difference < 0 ? "bad" : "ok" }
      );
      router.refresh();
    } else setMessage(out.error ?? "That could not be recorded.");
  }

  return (
    <>
      <button
        type="button"
        className={`tl-btn ${size === "sm" ? "sm" : "primary"}`}
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}>
        {received > 0 ? "Record a payment" : "Mark paid"}
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
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn primary" disabled={busy || (diff > 0 && !overAck)} onClick={() => void pay()}>
              Record the payment
            </button>
          </>
        }>
        <form
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && !(diff > 0 && !overAck)) void pay();
          }}>
          <Fld label="Amount received ($)" hint={received > 0 ? `The invoice is ${usd(billed, 2)}; ${usd(received, 2)} has come in, so ${usd(due, 2)} is owed.` : `The invoice is ${usd(billed, 2)}.`}>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Fld>
          <div className="dlg-two">
            <Fld label="Paid on" hint="Dallas date. Change it to enter an earlier payment.">
              <DateInput type="date" value={paidOn} max={nowLocal().slice(0, 10)} onChange={(e) => setPaidOn(e.target.value)} />
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
          {diff < 0 ? (
            <fieldset className="dlg-choice" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="tl-note warn">That is {usd(Math.abs(diff), 2)} short of what is owed. What should happen to the {usd(Math.abs(diff), 2)}?</legend>
              <label style={{ display: "block", margin: "6px 0" }}>
                <input type="radio" name="short" checked={shortAction === "balance"} onChange={() => setShortAction("balance")} /> Keep it open: {usd(Math.abs(diff), 2)} stays owed, and the invoice keeps ageing
              </label>
              {canWriteOff ? (
                <label style={{ display: "block", margin: "6px 0" }}>
                  <input type="radio" name="short" checked={shortAction === "writeoff"} onChange={() => setShortAction("writeoff")} /> Close the invoice and write the {usd(Math.abs(diff), 2)} off
                </label>
              ) : (
                <p className="tl-sub" style={{ margin: "6px 0" }}>Writing it off is for an admin. Keep it open here, and ask one to close it.</p>
              )}
              {canWriteOff && shortAction === "writeoff" ? (
                <Fld label="Why is it written off?" hint="Required. The customer's deduction, a damage claim, a negotiated discount. It goes in the audit trail.">
                  <input value={shortReason} onChange={(e) => setShortReason(e.target.value)} maxLength={200} />
                </Fld>
              ) : null}
            </fieldset>
          ) : diff > 0 ? (
            <label className="dlg-check">
              <input type="checkbox" checked={overAck} onChange={(e) => setOverAck(e.target.checked)} /> That is {usd(diff, 2)} more than is owed. Record it anyway, as paid over.
            </label>
          ) : null}
        </form>
      </Modal>
    </>
  );
}
