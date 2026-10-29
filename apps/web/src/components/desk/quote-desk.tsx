"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { bookQuoteAction, discardQuoteAction, passQuoteAction, priceQuoteAction, saveQuoteAction, type PricedQuote } from "@/app/(desk)/actions";
import { miles, perMile, shortDate, usd } from "@/lib/desk-format";
import { addressReady, roundMiles } from "@/lib/geo";
import { BAND_LABEL, BLANK_QUOTE, gateTitle, missingTimes, OVERRIDE_REASONS, PASS_REASONS, validateQuote, type QuoteStop, type QuoteValues } from "@/lib/quote";
import type { FitRow, QuoteListRow } from "@/server/tl/quote";
import type { Measured } from "@/server/geo/measure";
import { TRAILER_TYPES } from "@/truelane/constants/trailerData";
import { AddressInput } from "./address-input";
import { Icon } from "./kit/icons";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";

type Initial = { id: string | null; values: QuoteValues; vehicleId: string | null } | null;

/**
 * The phone's Calculate screen for a dispatcher. Type an offer and it is priced for every truck and driver as you go, with the verdict
 * the phone would give, so the question "which of my trucks should take this, and does it clear?" has an answer before anything is
 * booked. Save it as a quote to come back to, pass on it, or book it: a load that needs a reason (below its cost, no fuel price, below the
 * market, no market rate) asks for one first, and the answer is kept with the decision. A truck that cannot carry the load (heavier or bigger
 * than it is rated for) is listed last with the reason and cannot be picked.
 */
export function QuoteDesk({ quotes, brokers, initial }: { quotes: QuoteListRow[]; brokers: string[]; initial: Initial }) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = React.useState<QuoteValues>(initial?.values ?? BLANK_QUOTE);
  const [quoteId, setQuoteId] = React.useState<string | null>(initial?.id ?? null);
  const [priced, setPriced] = React.useState<PricedQuote | null>(null);
  const [pricing, setPricing] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState<string>("");
  const [notes, setNotes] = React.useState("");
  const [passing, setPassing] = React.useState(false);
  const [passReason, setPassReason] = React.useState<string>("");
  const [passNotes, setPassNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<{ loadId: string; loadNumber: string | null; note: string | null; assigned: boolean; truck: string } | null>(null);
  const seq = React.useRef(0);
  // Miles the map filled in are suggestions: a field somebody typed in is theirs, and a later measure leaves it alone.
  const manual = React.useRef(new Set<string>());
  const measureSeq = React.useRef(0);
  const routeKey = (stops: QuoteStop[]) => stops.map((s) => `${s.role}|${s.address.trim().toLowerCase()}`).join("~");
  const lastRoute = React.useRef(initial ? routeKey(initial.values.stops) : "");
  const [measure, setMeasure] = React.useState<{ state: "idle" | "busy" | "ok" | "error"; text: string }>({ state: "idle", text: "" });
  // The two rarely used groups open on their own when the quote already has something in them.
  const [paperOpen] = React.useState(() => !!initial && [initial.values.brokerMc, initial.values.loadNumber, initial.values.poNumber, initial.values.brokerPhone, initial.values.brokerEmail].some((x) => x.trim() !== ""));
  const [specOpen] = React.useState(() => !!initial && [initial.values.weightLbs, initial.values.lengthFt, initial.values.widthFt, initial.values.heightIn, initial.values.hazmatClass, initial.values.trailer].some((x) => x.trim() !== "") || !!(initial?.values.requiresLiftgate || initial?.values.requiresRamp || initial?.values.requiresPalletJack));

  const check = validateQuote(values);
  const errors: Record<string, string> = { ...serverErrors, ...(tried && !check.ok ? check.errors : {}) };

  // An error from the last try (a missing time, a refused booking) is about what was typed then: it goes as soon as the form changes.
  React.useEffect(() => {
    setServerErrors({});
    setMessage(null);
  }, [values]);

  // Price as you type: wait for a pause, and ignore an answer that a newer one has overtaken.
  React.useEffect(() => {
    const mine = ++seq.current;
    const timer = window.setTimeout(async () => {
      setPricing(true);
      try {
        const out = await priceQuoteAction(values);
        if (mine === seq.current) setPriced(out);
      } finally {
        if (mine === seq.current) setPricing(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [values]);

  // Measure on the road once every stop is something a map could find, a moment after the route stops changing.
  const routeNow = routeKey(values.stops);
  React.useEffect(() => {
    if (done || routeNow === lastRoute.current || !values.stops.every((s) => addressReady(s.address))) return;
    const mine = ++measureSeq.current;
    const timer = window.setTimeout(async () => {
      lastRoute.current = routeNow;
      setMeasure({ state: "busy", text: "Measuring the route…" });
      try {
        const res = await fetch("/geo/measure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stops: values.stops.map((s) => ({ address: s.address, role: s.role })) }) });
        const out = (await res.json()) as Measured;
        if (mine !== measureSeq.current) return;
        if (!out.ok) {
          setMeasure({ state: "error", text: out.error });
          return;
        }
        setValues((v) => {
          const next: QuoteValues = { ...v, emptyByTruck: { ...v.emptyByTruck }, emptyHomeByTruck: { ...v.emptyHomeByTruck } };
          if (!manual.current.has("loadedMiles")) {
            next.loadedMiles = String(out.loadedMiles);
            next.loadedHours = String(out.loadedHours);
          }
          for (const id of Object.keys(out.perTruck)) {
            const t = out.perTruck[id]!;
            if (t.toPickup != null && !manual.current.has(`empty:${id}`)) next.emptyByTruck[id] = String(roundMiles(t.toPickup + out.emptyMidMiles));
            if (t.home != null && !manual.current.has("emptyHome")) next.emptyHomeByTruck[id] = String(t.home);
          }
          // Empty driving inside the route is never dropped: a truck with no base carries it in the shared pickup figure.
          if (out.emptyMidMiles > 0 && !manual.current.has("emptyToPickup")) next.emptyToPickup = String(out.emptyMidMiles);
          return next;
        });
        const trucks = Object.keys(out.perTruck).length;
        setMeasure({
          state: "ok",
          text: `On the road: ${out.loadedMiles.toLocaleString("en-US")} mi loaded, about ${out.loadedHours.toLocaleString("en-US")} h of driving${trucks > 0 ? `; empty miles measured from ${trucks === 1 ? "the truck's base" : `${trucks} trucks' bases`}` : ""}. Type over any figure to use your own.`
        });
      } catch {
        if (mine === measureSeq.current) setMeasure({ state: "error", text: "Could not reach the map. Type the miles." });
      }
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeNow, done]);

  /** A figure typed by hand is the dispatcher's from then on; blanking it hands it back to the map. */
  const typedMiles = (field: "loadedMiles" | "emptyToPickup" | "emptyHome", v: string) => {
    if (v.trim() === "") manual.current.delete(field);
    else manual.current.add(field);
    setValues((cur) => ({ ...cur, [field]: v, ...(field === "loadedMiles" ? { loadedHours: "" } : {}), ...(field === "emptyHome" && v.trim() !== "" ? { emptyHomeByTruck: {} } : {}) }));
  };

  const rows: FitRow[] = priced?.ok ? priced.fit.rows : [];
  const row =
    rows.find((r) => r.key === selected) ??
    (initial?.vehicleId ? rows.find((r) => r.truckId === initial.vehicleId && !r.blocked) : undefined) ??
    rows.find((r) => !r.blocked) ??
    rows[0] ??
    null;

  const set = (patch: Partial<QuoteValues>) => setValues((v) => ({ ...v, ...patch }));
  const setStop = (i: number, patch: Partial<QuoteStop>) => setValues((v) => ({ ...v, stops: v.stops.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const addStop = () => setValues((v) => ({ ...v, stops: [...v.stops.slice(0, -1), { role: "delivery", address: "", appointment: "" }, v.stops[v.stops.length - 1]!] }));
  const removeStop = (i: number) => setValues((v) => ({ ...v, stops: v.stops.filter((_, k) => k !== i) }));
  const reset = () => {
    setValues(BLANK_QUOTE);
    setQuoteId(null);
    setSelected(null);
    setTried(false);
    setServerErrors({});
    setMessage(null);
    setDone(null);
    setPriced(null);
    manual.current.clear();
    lastRoute.current = "";
    measureSeq.current += 1;
    setMeasure({ state: "idle", text: "" });
  };

  async function book(override: { reason: string; notes: string } | null) {
    if (!row) return;
    setBusy(true);
    setMessage(null);
    const out = await bookQuoteAction(values, { vehicleId: row.truckId, driverId: row.driverId }, override, quoteId);
    setBusy(false);
    if (out.ok) {
      setAsking(false);
      setDone({ loadId: out.loadId, loadNumber: out.loadNumber, note: out.note, assigned: out.assigned, truck: row.truckName });
      router.refresh();
      return;
    }
    setServerErrors(out.errors ?? {});
    if (out.errors) setTried(true);
    if (out.gate) setAsking(true);
    setMessage(out.error ?? (out.errors ? "Fix what is marked, then book it." : null));
  }

  function onBook() {
    setTried(true);
    setServerErrors({});
    if (!check.ok) {
      setMessage("Fix what is marked, then book it.");
      return;
    }
    const times = missingTimes(values.stops);
    if (Object.keys(times).length > 0) {
      setServerErrors(times);
      setMessage("Add the pickup and delivery times to book it.");
      return;
    }
    if (row?.gate) {
      setAsking(true);
      return;
    }
    void book(null);
  }

  async function onSave() {
    setTried(true);
    if (!check.ok) {
      setMessage("Fix what is marked, then save it.");
      return;
    }
    setBusy(true);
    const out = await saveQuoteAction(values, quoteId, row?.truckId ?? null);
    setBusy(false);
    if (out.ok) {
      setQuoteId(out.id);
      setMessage(null);
      toast({ text: "Quote saved. It is not on the board until you book it.", tone: "ok" });
      router.refresh();
    } else {
      setServerErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked, then save it.");
    }
  }

  /** Pass on it: the quote is kept (saved first when it was only typed) with the reason, so the lane and the broker are remembered. */
  function onOpenPass() {
    setTried(true);
    if (!check.ok) {
      setMessage("Fix what is marked, then pass on it.");
      return;
    }
    setPassReason("");
    setPassNotes("");
    setPassing(true);
  }

  async function onPass() {
    setBusy(true);
    let id = quoteId;
    if (!id) {
      const saved = await saveQuoteAction(values, null, row?.truckId ?? null);
      if (!saved.ok) {
        setBusy(false);
        setPassing(false);
        setServerErrors(saved.errors ?? {});
        setMessage(saved.error ?? "Fix what is marked, then pass on it.");
        return;
      }
      id = saved.id;
    }
    const out = await passQuoteAction(id, passReason, passNotes);
    setBusy(false);
    if (!out.ok) {
      setMessage(out.error);
      return;
    }
    setPassing(false);
    toast({ text: `Passed: ${passReason}. It stays in Saved quotes.`, tone: "ok" });
    reset();
    router.replace("/quote");
    router.refresh();
  }

  const err = (k: string) => errors[k];
  const stopCount = values.stops.length;

  if (done) {
    return (
      <div className="tl-card rc-done" role="status">
        <span className="ico ok">
          <Icon name="check" size={22} />
        </span>
        <div className="grow">
          <h3>{done.loadNumber ?? "The load"} is booked on {done.truck}</h3>
          <p className="tl-note">{done.note ?? (done.assigned ? "The driver is on it, not sent yet. Send it from the load." : "It is on the Dispatch queue, needing a driver.")}</p>
        </div>
        <Link className="tl-btn primary" href={`/loads/${done.loadId}`}>
          Open the load
        </Link>
        <button type="button" className="tl-btn" onClick={reset}>
          Quote another
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="qt">
        <div className="qt-main">
          <section className="tl-card">
            <h2>Route</h2>
            {err("stops") ? <p className="th-err" role="alert">{err("stops")}</p> : null}
            <ol className="qt-stops">
              {values.stops.map((s, i) => {
                const first = i === 0;
                const last = i === stopCount - 1;
                return (
                  <li key={i} className="qt-stop">
                    {first || last ? (
                      <span className="qt-role">{first ? "Pickup" : "Delivery"}</span>
                    ) : (
                      <select aria-label={`Stop ${i + 1} is a`} value={s.role} onChange={(e) => setStop(i, { role: e.target.value as QuoteStop["role"] })}>
                        <option value="pickup">Pickup</option>
                        <option value="delivery">Delivery</option>
                      </select>
                    )}
                    <label className="tl-field qt-addr">
                      <span className="db-sr-only">Stop {i + 1} address</span>
                      <AddressInput label={`Stop ${i + 1} address`} value={s.address} placeholder={first ? "Dallas, TX" : last ? "Atlanta, GA" : "City, ST"} onChange={(text) => setStop(i, { address: text })} invalid={!!err(`stop${i}`)} />
                      {err(`stop${i}`) ? <span className="th-err">{err(`stop${i}`)}</span> : null}
                    </label>
                    <label className="tl-field qt-when">
                      <span className="db-sr-only">Stop {i + 1} time, Dallas time</span>
                      <input type="datetime-local" value={s.appointment} onChange={(e) => setStop(i, { appointment: e.target.value })} aria-invalid={err(`stop${i}Time`) ? true : undefined} />
                      {err(`stop${i}Time`) ? <span className="th-err">{err(`stop${i}Time`)}</span> : null}
                    </label>
                    {!first && !last ? (
                      <button type="button" className="tl-btn ghost sm" aria-label={`Remove stop ${i + 1}`} onClick={() => removeStop(i)}>
                        <Icon name="close" size={14} />
                      </button>
                    ) : (
                      <span />
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="qt-stops-foot">
              <button type="button" className="tl-btn sm" onClick={addStop}>
                Add a stop
              </button>
              <span className="tl-sub">Times are Dallas time, needed to book it and not to price it.</span>
            </div>
          </section>

          <section className="tl-card">
            <h2>The deal</h2>
            <div className="qt-grid">
              <label className="tl-field th-field">
                Broker
                <input list="qt-brokers" value={values.broker} onChange={(e) => set({ broker: e.target.value })} autoComplete="off" />
                <datalist id="qt-brokers">
                  {brokers.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </label>
              <Money label="Offer" unit="$" value={values.offer} error={err("offer")} onChange={(v) => set({ offer: v })} />
              <div className="th-field">
                <label htmlFor="qt-fsc">Fuel surcharge</label>
                <div className="th-input">
                  <input id="qt-fsc" inputMode="decimal" value={values.fsc} autoComplete="off" onChange={(e) => set({ fsc: e.target.value })} aria-invalid={err("fsc") ? true : undefined} />
                  <div className="cp-seg" role="group" aria-label="Surcharge unit">
                    <button type="button" aria-pressed={values.fscUnit === "percent"} onClick={() => set({ fscUnit: "percent" })}>
                      %
                    </button>
                    <button type="button" aria-pressed={values.fscUnit === "per_mile"} onClick={() => set({ fscUnit: "per_mile" })}>
                      $ a mile
                    </button>
                  </div>
                </div>
                {err("fsc") ? <span className="th-err">{err("fsc")}</span> : null}
              </div>
              <Money label="Market rate" unit="$ total" value={values.marketRate} error={err("marketRate")} onChange={(v) => set({ marketRate: v })} hint="The total for the load, not per mile. Blank skips the market check." />
              <Money label="Pay terms" unit="days" value={values.payTermsDays} error={err("payTermsDays")} onChange={(v) => set({ payTermsDays: v })} />
              <Money label="Factoring fee" unit="%" value={values.factoringPct} error={err("factoringPct")} onChange={(v) => set({ factoringPct: v })} hint="Blank uses each truck's own." />
            </div>
            <details className="qt-more" open={paperOpen || undefined}>
              <summary>Broker paperwork</summary>
              <div className="qt-grid">
                <label className="tl-field">
                  MC number
                  <input value={values.brokerMc} onChange={(e) => set({ brokerMc: e.target.value })} inputMode="numeric" autoComplete="off" aria-invalid={err("brokerMc") ? true : undefined} />
                  {err("brokerMc") ? <span className="th-err" role="alert">{err("brokerMc")}</span> : null}
                </label>
                <label className="tl-field">
                  Their load number
                  <input value={values.loadNumber} onChange={(e) => set({ loadNumber: e.target.value })} autoComplete="off" />
                </label>
                <label className="tl-field">
                  PO number
                  <input value={values.poNumber} onChange={(e) => set({ poNumber: e.target.value })} autoComplete="off" />
                </label>
                <label className="tl-field">
                  Phone
                  <input value={values.brokerPhone} onChange={(e) => set({ brokerPhone: e.target.value })} inputMode="tel" autoComplete="off" aria-invalid={err("brokerPhone") ? true : undefined} />
                  {err("brokerPhone") ? <span className="th-err" role="alert">{err("brokerPhone")}</span> : null}
                </label>
                <label className="tl-field">
                  Email
                  <input value={values.brokerEmail} onChange={(e) => set({ brokerEmail: e.target.value })} inputMode="email" autoComplete="off" aria-invalid={err("brokerEmail") ? true : undefined} />
                  {err("brokerEmail") ? <span className="th-err" role="alert">{err("brokerEmail")}</span> : null}
                </label>
              </div>
            </details>
          </section>

          <section className="tl-card">
            <h2>Miles</h2>
            {measure.text ? (
              <p className={`tl-note${measure.state === "error" ? " warn" : ""}`} role="status" style={{ marginBottom: 10 }}>
                {measure.text}
              </p>
            ) : null}
            <div className="qt-grid">
              <Money label="Loaded" unit="miles" value={values.loadedMiles} error={err("loadedMiles")} onChange={(v) => typedMiles("loadedMiles", v)} />
              <Money label="Empty to the pickup" unit="miles" value={values.emptyToPickup} error={err("emptyToPickup")} onChange={(v) => typedMiles("emptyToPickup", v)} hint="Each truck with a base is measured below." />
              <Money label="Empty home after" unit="miles" value={values.emptyHome} error={err("emptyHome")} onChange={(v) => typedMiles("emptyHome", v)} />
              <label className="dlg-check qt-check">
                <input type="checkbox" checked={values.loadBack} onChange={(e) => set({ loadBack: e.target.checked })} />
                I have a load back: the way home is covered
              </label>
            </div>
          </section>

          <section className="tl-card">
            <details className="qt-more qt-spec" open={specOpen || undefined}>
              <summary>
                Load details <span className="tl-sub">Weight, size, trailer, what it needs. A truck that cannot take it is not offered.</span>
              </summary>
              <div className="qt-grid">
                <Money label="Weight" unit="lb" value={values.weightLbs} error={err("weightLbs")} onChange={(v) => set({ weightLbs: v })} />
                <Money label="Length" unit="ft" value={values.lengthFt} error={err("lengthFt")} onChange={(v) => set({ lengthFt: v })} />
                <Money label="Width" unit="ft" value={values.widthFt} error={err("widthFt")} onChange={(v) => set({ widthFt: v })} />
                <Money label="Height" unit="in" value={values.heightIn} error={err("heightIn")} onChange={(v) => set({ heightIn: v })} />
                <label className="tl-field">
                  Trailer
                  <select value={values.trailer} onChange={(e) => set({ trailer: e.target.value })}>
                    <option value="">Not stated</option>
                    {TRAILER_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tl-field">
                  Hazmat class
                  <input value={values.hazmatClass} onChange={(e) => set({ hazmatClass: e.target.value })} placeholder="None" autoComplete="off" aria-invalid={err("hazmatClass") ? true : undefined} />
                  {err("hazmatClass") ? <span className="th-err" role="alert">{err("hazmatClass")}</span> : null}
                </label>
              </div>
              <div className="th-checks qt-needs">
                <span className="tl-sub">Needs</span>
                <label className="dlg-check">
                  <input type="checkbox" checked={values.requiresLiftgate} onChange={(e) => set({ requiresLiftgate: e.target.checked })} />
                  Liftgate
                </label>
                <label className="dlg-check">
                  <input type="checkbox" checked={values.requiresRamp} onChange={(e) => set({ requiresRamp: e.target.checked })} />
                  Ramp
                </label>
                <label className="dlg-check">
                  <input type="checkbox" checked={values.requiresPalletJack} onChange={(e) => set({ requiresPalletJack: e.target.checked })} />
                  Pallet jack
                </label>
              </div>
            </details>
          </section>
        </div>

        <aside className="qt-side" aria-label="The verdict" aria-live="polite">
          <h2 className="rc-eyebrow">{row ? `Priced for ${row.truckName}${row.driverName ? ` · ${row.driverName}` : ""}` : "The verdict"}</h2>
          {row ? <Verdict row={row} values={values} /> : <p className="tl-note">{priced && !priced.ok ? "Type the offer and the loaded miles to price it." : pricing ? "Pricing…" : priced?.ok && priced.fit.skipped.length > 0 ? "No truck has a cost profile to price against." : "Type the offer and the loaded miles to price it."}</p>}
          {priced?.ok && priced.warnings.map((w) => <p key={w} className="tl-note warn">{w}</p>)}
          {message ? (
            <p className="tl-note warn" role="alert">
              {message}
            </p>
          ) : null}
          <div className="qt-actions">
            <button type="button" className="tl-btn primary" disabled={busy || !row || !!row.blocked} aria-busy={busy || undefined} onClick={onBook}>
              {row ? `Book on ${row.truckName}${row.driverName ? ` with ${row.driverName.split(" ")[0]}` : ""}` : "Book it"}
            </button>
            <div className="qt-actions-row">
              <button type="button" className="tl-btn" disabled={busy} onClick={() => void onSave()}>
                {quoteId ? "Update quote" : "Save as a quote"}
              </button>
              <button type="button" className="tl-btn ghost" disabled={busy || !row} onClick={onOpenPass}>
                Pass on it
              </button>
            </div>
          </div>
          {row?.blocked ? (
            <p className="tl-note warn">
              {row.truckName}
              {row.driverName ? ` with ${row.driverName}` : ""} cannot take it: {row.blocked} Pick another row.
            </p>
          ) : null}
        </aside>
      </div>

      <section className="qt-fit">
        <div className="rc-list-head">
          <h2 className="rc-eyebrow">Which truck and driver</h2>
          <span className="tl-sub">{pricing ? "Pricing…" : rows.length > 0 ? `${rows.length} ${rows.length === 1 ? "way" : "ways"} to run it, best first` : ""}</span>
        </div>
        {rows.length === 0 ? (
          <p className="tl-note">Every truck and driver is priced here once there is an offer and loaded miles.</p>
        ) : (
          <div className="dt-wrap qt-scroll">
            <table className="tl-table qt-table">
              <thead>
                <tr>
                  <th aria-label="Choose" />
                  <th>Truck and driver</th>
                  <th className="num">Empty to pickup</th>
                  <th>Verdict</th>
                  <th className="num">Every mile</th>
                  <th className="num">Floor</th>
                  <th className="num">Left over</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const band = BAND_LABEL[r.band];
                  const on = row?.key === r.key;
                  return (
                    <tr key={r.key} className={`${on ? "qt-on" : ""}${r.blocked ? " qt-off" : ""}`.trim() || undefined} onClick={() => setSelected(r.key)}>
                      <td>
                        <input type="radio" name="qt-pick" checked={on} onChange={() => setSelected(r.key)} aria-label={`Run it on ${r.truckName}${r.driverName ? ` with ${r.driverName}` : ""}`} />
                      </td>
                      <td>
                        <b>{r.truckName}</b>
                        <span className="sub">{r.driverName ? `${r.driverName} · ${shortLabour(r)}` : "No driver set on this truck"}</span>
                        {r.blocked ? <span className="sub neg">{r.blocked}</span> : null}
                        {r.warnings.map((w) => (
                          <span key={w} className="sub warn">
                            {w}
                          </span>
                        ))}
                      </td>
                      <td className="num">
                        <input
                          className="qt-mini"
                          inputMode="decimal"
                          aria-label={`Empty miles to the pickup for ${r.truckName}`}
                          placeholder={values.emptyToPickup || "0"}
                          value={values.emptyByTruck[r.truckId] ?? ""}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            if (e.target.value.trim() === "") manual.current.delete(`empty:${r.truckId}`);
                            else manual.current.add(`empty:${r.truckId}`);
                            set({ emptyByTruck: { ...values.emptyByTruck, [r.truckId]: e.target.value } });
                          }}
                        />
                        {values.emptyHomeByTruck[r.truckId] ? <span className="sub">+ {values.emptyHomeByTruck[r.truckId]} home</span> : null}
                      </td>
                      <td>
                        <span className={`tl-chip ${band.tone}`}>{band.label}</span>
                      </td>
                      <td className="num">{perMile(r.allInPerMile)}</td>
                      <td className="num">{perMile(r.floorPerMile)}</td>
                      <td className={`num ${r.leftOver != null && r.leftOver < 0 ? "neg" : ""}`}>{r.leftOver == null ? "—" : `${r.leftOver < 0 ? "−" : ""}${usd(Math.abs(r.leftOver), 0)}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {priced?.ok && priced.fit.skipped.length > 0 ? <p className="tl-note" style={{ marginTop: 8 }}>{priced.fit.skipped.map((s) => `${s.truck}: ${s.why}`).join(" ")}</p> : null}
      </section>

      {priced?.ok && (priced.context.lane || priced.context.broker) ? (
        <div className="qt-context">
          {priced.context.lane ? (
            <section className="tl-card">
              <h2>{`Last time on ${priced.context.lane.from} to ${priced.context.lane.to}`}</h2>
              <p className="tl-note" style={{ marginBottom: 8 }}>
                {priced.context.lane.count} finished {priced.context.lane.count === 1 ? "load" : "loads"}
                {priced.context.lane.averagePerMile != null ? `, averaging ${perMile(priced.context.lane.averagePerMile)} on the loaded miles` : ""}.
              </p>
              <table className="tl-table">
                <tbody>
                  {priced.context.lane.recent.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link href={`/loads/${l.id}`}>{l.loadNumber ?? "Load"}</Link>
                      </td>
                      <td>{shortDate(l.on)}</td>
                      <td className="num">{usd(l.gross, 0)}</td>
                      <td className="num">{perMile(l.perMile)}</td>
                      <td className="tl-sub">{l.broker ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
          {priced.context.broker ? (
            <section className="tl-card">
              <h2>{priced.context.broker.name}</h2>
              <dl className="tl-kv">
                <dt>Loads with them</dt>
                <dd>{priced.context.broker.loads}</dd>
                <dt>Finished</dt>
                <dd>{priced.context.broker.finished}</dd>
                <dt>Fell through</dt>
                <dd>{priced.context.broker.fellThrough}</dd>
                <dt>Average per loaded mile</dt>
                <dd>{perMile(priced.context.broker.averagePerMile)}</dd>
                <dt>Average days to pay</dt>
                <dd>{priced.context.broker.averageDaysToPay == null ? "No paid invoices yet" : `${priced.context.broker.averageDaysToPay.toFixed(1)} days`}</dd>
              </dl>
            </section>
          ) : null}
        </div>
      ) : null}

      <section className="qt-quotes">
        <div className="rc-list-head">
          <h2 className="rc-eyebrow">Saved quotes</h2>
          <span className="tl-sub">{quotes.length === 0 ? "" : `${quotes.filter((q) => !q.passedFor).length} open, ${quotes.filter((q) => q.passedFor).length} passed`}</span>
        </div>
        {quotes.length === 0 ? (
          <p className="tl-note">Nothing saved. A quote you save waits off the board until you book it.</p>
        ) : (
          <div className="dt-wrap qt-scroll">
            <table className="tl-table">
              <thead>
                <tr>
                  <th>Lane</th>
                  <th>Broker</th>
                  <th className="num">Offer</th>
                  <th className="num">Loaded</th>
                  <th>Outcome</th>
                  <th>Saved</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id} className={q.id === quoteId ? "qt-on" : undefined}>
                    <td>
                      <b>{q.lane}</b>
                    </td>
                    <td>{q.broker ?? "—"}</td>
                    <td className="num">{usd(q.offer, 0)}</td>
                    <td className="num">{miles(q.loadedMiles)}</td>
                    <td>{q.passedFor ? <span className="tl-chip muted">{`Passed · ${q.passedFor}`}</span> : <span className="tl-chip info">Open</span>}</td>
                    <td>{shortDate(q.savedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <Link className="tl-btn sm" href={`/quote?quote=${q.id}`}>
                          Reopen
                        </Link>
                        <Link className="tl-btn ghost sm" href={`/quote?like=${q.id}`}>
                          Quote like this
                        </Link>
                        <button
                          type="button"
                          className="tl-btn ghost sm"
                          onClick={async () => {
                            const out = await discardQuoteAction(q.id);
                            if (out.ok) {
                              if (q.id === quoteId) setQuoteId(null);
                              router.refresh();
                              toast({ text: "Quote discarded.", tone: "ok" });
                            }
                          }}>
                          Discard
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal open={asking} onClose={() => setAsking(false)} eyebrow="Before booking" title={row?.gate ? gateTitle(row.gate) : "Book it?"}>
        <div className="dlg-form">
          <p className="tl-note">The reason is kept with the decision and in the audit log.</p>
          <div role="radiogroup" aria-label="Reason" className="qt-reasons">
            {OVERRIDE_REASONS.map((r) => (
              <label key={r} className="dlg-check">
                <input type="radio" name="qt-reason" checked={reason === r} onChange={() => setReason(r)} />
                {r}
              </label>
            ))}
          </div>
          <label className="tl-field">
            Notes {reason === "Other" ? "(say what the reason is)" : "(optional)"}
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="A few words" />
          </label>
          {message ? <p className="tl-note warn" role="alert">{message}</p> : null}
          <div className="dlg-actions">
            <button type="button" className="tl-btn" onClick={() => setAsking(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy || reason === "" || (reason === "Other" && notes.trim().length < 3)} onClick={() => void book({ reason, notes })}>
              Book it anyway
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={passing} onClose={() => setPassing(false)} eyebrow="Pass on it" title="Why pass on this one?">
        <div className="dlg-form">
          <p className="tl-note">The quote is kept with the reason, so the lane and the broker are remembered.</p>
          <div role="radiogroup" aria-label="Why pass" className="qt-reasons">
            {PASS_REASONS.map((r) => (
              <label key={r} className="dlg-check">
                <input type="radio" name="qt-pass-reason" checked={passReason === r} onChange={() => setPassReason(r)} />
                {r}
              </label>
            ))}
          </div>
          <label className="tl-field">
            Notes {passReason === "Other" ? "(say what the reason is)" : "(optional)"}
            <textarea value={passNotes} onChange={(e) => setPassNotes(e.target.value)} placeholder="A few words" />
          </label>
          {message ? <p className="tl-note warn" role="alert">{message}</p> : null}
          <div className="dlg-actions">
            <button type="button" className="tl-btn" onClick={() => setPassing(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy || passReason === "" || (passReason === "Other" && passNotes.trim().length < 3)} onClick={() => void onPass()}>
              Pass on it
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function shortLabour(r: FitRow): string {
  const m = /: (.*?), plus/.exec(r.labourNote);
  return m ? `pay ${m[1]}` : r.labourNote;
}

function Money({ label, unit, value, error, onChange, hint }: { label: string; unit: string; value: string; error?: string; onChange: (v: string) => void; hint?: string }) {
  const id = `qt-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="th-field">
      <label htmlFor={id}>{label}</label>
      <div className="th-input">
        <input id={id} inputMode="decimal" autoComplete="off" value={value} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)} />
        <span>{unit}</span>
      </div>
      {error ? (
        <span className="th-err" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="th-hint">{hint}</span>
      ) : null}
    </div>
  );
}

/** The hero: the band, the per-mile figure with the miles it is per, what the floor is, and every reason to pause. */
function Verdict({ row, values }: { row: FitRow; values: QuoteValues }) {
  const band = BAND_LABEL[row.band];
  const d = row.detail;
  const home = values.loadBack ? "a load covers the way home" : Number(values.emptyHome) > 0 ? `${miles(Number(values.emptyHome))} empty home` : "no empty miles home";
  const notes: string[] = [];
  if (row.band === "needs_fuel") notes.push("Add the truck's mpg and a fuel price on its page to get a verdict.");
  if (d.rejectReason) notes.push(d.rejectReason);
  if (d.routeMinimum && !d.routeMinimum.meets) notes.push(`The route minimum of ${usd(d.routeMinimum.expected, 0)} is not met.`);
  if (d.thinMargin) notes.push("It clears, but by less than five cents a mile.");
  if (d.timeTrap && d.profitPerHour != null) notes.push(`Profit per trip hour is ${usd(d.profitPerHour, 2)}, under the ${usd(d.hourlyTarget, 0)} an hour target.`);
  if (d.requiredRests > 0) notes.push(`A run this long needs ${d.requiredRests} ten-hour ${d.requiredRests === 1 ? "rest" : "rests"}: about ${d.elapsedHours.toFixed(0)} hours elapsed.`);
  const fitNotes = row.warnings;
  return (
    <div className="qt-verdict">
      <div>
        <span className={`tl-chip ${band.tone} qt-band`}>{band.label}</span>
      </div>
      <div className="qt-big">
        {perMile(row.allInPerMile)} <span>all-in</span>
      </div>
      <p className="tl-note">
        on {miles(row.totalMiles)} · {home}
      </p>
      <dl className="rc-facts">
        <div>
          <dt>Floor ({d.floorName})</dt>
          <dd>{perMile(row.floorPerMile)}</dd>
        </div>
        <div>
          <dt>{row.marginPerMile != null && row.marginPerMile < 0 ? "Short by" : "Clears by"}</dt>
          <dd>{row.marginPerMile == null ? "—" : `${perMile(Math.abs(row.marginPerMile))}`}</dd>
        </div>
        <div>
          <dt>Pay with surcharge</dt>
          <dd>{usd(d.effectiveGross, 2)}</dd>
        </div>
        {d.marketVariancePct != null ? (
          <div>
            <dt>Against the market</dt>
            <dd>
              {d.marketVariancePct >= 0 ? "+" : "−"}
              {Math.abs(d.marketVariancePct * 100).toFixed(1)}%
              {d.marketVarianceDollars != null ? ` (${d.marketVarianceDollars >= 0 ? "+" : "−"}${usd(Math.abs(d.marketVarianceDollars), 0)})` : ""}
            </dd>
          </div>
        ) : null}
        {row.decision === "reject" || row.band === "below_floor" ? (
          <div>
            <dt>Pay needed to cover it</dt>
            <dd>{usd(d.payNeeded, 0)}</dd>
          </div>
        ) : null}
        {d.fuelPerMile != null ? (
          <div>
            <dt>Fuel</dt>
            <dd>{perMile(d.fuelPerMile)}</dd>
          </div>
        ) : null}
      </dl>
      <p className="tl-note">{row.labourNote}</p>
      {notes.length > 0 ? (
        <ul className="rc-todo qt-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {fitNotes.length > 0 ? (
        <ul className="rc-warns-list">
          {fitNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
