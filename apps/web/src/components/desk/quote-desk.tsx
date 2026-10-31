"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { bookQuoteAction, discardQuoteAction, listQuotesAction, passQuoteAction, priceQuoteAction, saveQuoteAction, type PricedQuote } from "@/app/(desk)/actions";
import { UNREACHABLE } from "@/lib/connection";
import { miles, perMile, shortDate, usd } from "@/lib/desk-format";
import { addressReady, roundMiles } from "@/lib/geo";
import { BLANK_QUOTE, gateTitle, HAZMAT_CLASSES, missingTimes, OVERRIDE_REASONS, PASS_REASONS, readQuote, validateQuote, type QuoteStop, type QuoteValues } from "@/lib/quote";
import type { CustomerOption, FitRow, LaneBenchmark, QuoteListRow } from "@/server/tl/quote";
import type { Measured } from "@/server/geo/measure";
import { groundOf, readVerdict, type Benchmark, type Verdict as VerdictRead } from "@/lib/verdict";
import { VerdictHead, VerdictRuler, VerdictTag } from "./verdict-card";
import { TRAILER_TYPES } from "@/truelane/constants/trailerData";
import { AddressInput } from "./address-input";
import { AuthorityStatus, useAuthorityLookup } from "./customer-authority";
import { LiveFuelPrice } from "./live-fuel-price";
import { Icon } from "./kit/icons";
import { DraftNote, useDraft } from "./kit/use-draft";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { DateInput } from "./date-input";

/** How long ago an ISO time was, in the unit that reads best: "3 min ago", "2 h ago", "1 d ago". */
const ago = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return min < 90 ? `${min} min ago` : min < 60 * 36 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
};

type Initial = { id: string | null; values: QuoteValues; vehicleId: string | null; /** Why it was passed on, when it was: the quote is then read, not edited. */ passedFor: string | null } | null;

/**
 * The phone's Calculate screen for a dispatcher. Type an offer and it is priced for every truck and driver as you go, with the verdict
 * the phone would give, so the question "which of my trucks should take this, and does it clear?" has an answer before anything is
 * booked. Save it as a quote to come back to, pass on it, or book it: a load that needs a reason (below its cost, no fuel price, well under
 * the market or its own lane) asks for one first, and the answer is kept with the decision. A truck that cannot carry the load (heavier or bigger
 * than it is rated for) is listed last with the reason and cannot be picked.
 */
export function QuoteDesk({ quotes: firstPage, brokers, initial, canWrite }: { quotes: { rows: QuoteListRow[]; total: number }; brokers: CustomerOption[]; initial: Initial; canWrite: boolean }) {
  const router = useRouter();
  const toast = useToast();
  // The saved quotes, searched and filtered on the server a page at a time.
  const [list, setList] = React.useState(firstPage);
  const [listQuery, setListQuery] = React.useState("");
  const [listStatus, setListStatus] = React.useState<"open" | "passed" | "all">("open");
  const quotes = list.rows;
  React.useEffect(() => setList(firstPage), [firstPage]);
  const listSeq = React.useRef(0);
  const refilter = (q: string, status: "open" | "passed" | "all", more = false) => {
    const mine = ++listSeq.current;
    void listQuotesAction(q, status, more ? list.rows.length : 0)
      .then((out) => {
        if (mine === listSeq.current) setList((cur) => (more ? { total: out.total, rows: [...cur.rows, ...out.rows] } : out));
      })
      .catch(() => undefined);
  };
  const readOnly = !!initial?.passedFor;
  const locked = readOnly || !canWrite;
  // What is typed here is kept until the person saves, books or starts over: leaving for another module or refreshing does not lose it.
  const draftKey = `quote:${initial ? (initial.id ?? "like") : "new"}`;
  const [values, setValues, draft] = useDraft<QuoteValues>(draftKey, initial?.values ?? BLANK_QUOTE);
  const [quoteId, setQuoteId] = React.useState<string | null>(initial?.id ?? null);
  const [priced, setPriced] = React.useState<PricedQuote | null>(null);
  const [pricing, setPricing] = React.useState(false);
  const [priceFailed, setPriceFailed] = React.useState(false);
  const [priceAgain, setPriceAgain] = React.useState(0);
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
  const manual = React.useRef(new Set<string>(initial?.values.manual ?? []));
  const measureSeq = React.useRef(0);
  // Blanking a measured figure hands it back to the map: this bumps so the route is measured again.
  const [remeasure, setRemeasure] = React.useState(0);
  const routeKey = (stops: QuoteStop[]) => stops.map((s) => `${s.role}|${s.address.trim().toLowerCase()}`).join("~");
  const lastRoute = React.useRef(initial ? routeKey(initial.values.stops) : "");
  const [measure, setMeasure] = React.useState<{ state: "idle" | "busy" | "ok" | "error"; text: string }>({ state: "idle", text: "" });
  // Picked up from a kept draft: the miles it had are not measured again (a paid call, and it could overwrite a typed figure), and the typed ones stay typed.
  const resumed = React.useRef(false);
  React.useLayoutEffect(() => {
    if (resumed.current || !draft.kept) return;
    resumed.current = true;
    manual.current = new Set(values.manual);
    lastRoute.current = routeKey(values.stops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.kept]);
  // Which figures were typed by hand (the map leaves those alone) is kept in the values, so it is kept with the quote and the draft.
  React.useEffect(() => {
    const now = [...manual.current].sort();
    if (JSON.stringify(now) !== JSON.stringify([...(values.manual ?? [])].sort())) setValues((v) => ({ ...v, manual: now }));
  }, [values, setValues]);
  // The two rarely used groups open on their own when the quote already has something in them.
  const paperFilled = (v: QuoteValues) => [v.brokerMc, v.loadNumber, v.poNumber, v.brokerPhone, v.brokerEmail].some((x) => (x ?? "").trim() !== "");
  const [paperOpen, setPaperOpen] = React.useState(() => !!initial && paperFilled(initial.values));
  React.useEffect(() => {
    if (paperFilled(values)) setPaperOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.brokerMc, values.loadNumber, values.poNumber, values.brokerPhone, values.brokerEmail]);
  const advancedFilled = (v: QuoteValues) => [v.dockWaitMinutes, v.towingPerMile, v.permitEscort, v.insuranceRider, v.marketBand].some((x) => (x ?? "").trim() !== "") || (v.loadedHours ?? "").trim() !== "" && manual.current.has("loadedHours");
  const [advancedOpen, setAdvancedOpen] = React.useState(() => !!initial && advancedFilled(initial.values));
  // A kept draft with something in the advanced costs opens the group once it is back.
  React.useEffect(() => {
    if (advancedFilled(values)) setAdvancedOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.dockWaitMinutes, values.towingPerMile, values.permitEscort, values.insuranceRider, values.marketBand]);
  const specFilled = (v: QuoteValues) => [v.weightLbs, v.lengthFt, v.widthFt, v.heightIn, v.hazmatClass, v.trailer].some((x) => (x ?? "").trim() !== "") || !!(v.requiresLiftgate || v.requiresRamp || v.requiresPalletJack);
  const [specOpen, setSpecOpen] = React.useState(() => !!initial && specFilled(initial.values));
  React.useEffect(() => {
    if (specFilled(values)) setSpecOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.weightLbs, values.lengthFt, values.widthFt, values.heightIn, values.hazmatClass, values.trailer, values.requiresLiftgate, values.requiresRamp, values.requiresPalletJack]);

  const check = validateQuote(values);
  // A customer the desk has a record of fills its paperwork in, once, into what is still blank (or still what the last customer put there), and its spelling is the record's.
  const customer = brokers.find((b) => b.name.trim().toLowerCase() === values.broker.trim().toLowerCase()) ?? null;
  const filled = React.useRef<{ mc: string; phone: string; email: string; terms: string } | null>(null);
  const [filledFrom, setFilledFrom] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!customer || !(customer.mc || customer.phone || customer.email || customer.payTermsDays != null)) return;
    const was = filled.current;
    const next = { mc: customer.mc ?? "", phone: customer.phone ?? "", email: customer.email ?? "", terms: customer.payTermsDays != null ? String(customer.payTermsDays) : "" };
    setValues((v) => {
      const ours = (cur: string, old: string | undefined) => cur.trim() === "" || cur === old;
      return {
        ...v,
        broker: customer.name,
        brokerMc: ours(v.brokerMc, was?.mc) ? next.mc : v.brokerMc,
        brokerPhone: ours(v.brokerPhone, was?.phone) ? next.phone : v.brokerPhone,
        brokerEmail: ours(v.brokerEmail, was?.email) ? next.email : v.brokerEmail,
        payTermsDays: ours(v.payTermsDays, was?.terms) ? next.terms : v.payTermsDays
      };
    });
    filled.current = next;
    setFilledFrom(customer.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.name]);
  // The fuel price the verdict was priced with, whatever else on the form is not yet right.
  const usedFuel = readQuote(values)?.fuelPrice ?? null;
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
        if (mine === seq.current) {
          setPriced(out);
          setPriceFailed(false);
        }
      } catch {
        // No verdict rather than a stale one: the card must never show the answer to what was typed before.
        if (mine === seq.current) {
          setPriced(null);
          setPriceFailed(true);
        }
      } finally {
        if (mine === seq.current) setPricing(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [values, priceAgain]);

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
          // A lookup that failed is tried again when the route changes or "Measure again" is pressed, not skipped for good.
          lastRoute.current = "";
          setMeasure({ state: "error", text: out.error });
          return;
        }
        setValues((v) => {
          const next: QuoteValues = { ...v, emptyByTruck: { ...v.emptyByTruck }, emptyHomeByTruck: { ...v.emptyHomeByTruck } };
          if (!manual.current.has("loadedMiles")) {
            next.loadedMiles = String(out.loadedMiles);
            if (!manual.current.has("loadedHours")) next.loadedHours = String(out.loadedHours);
          }
          // A figure the last route measured for a truck this route could not place is not this route's: it goes, unless somebody typed it.
          for (const id of Object.keys(next.emptyByTruck)) if (!manual.current.has(`empty:${id}`) && out.perTruck[id]?.toPickup == null) delete next.emptyByTruck[id];
          for (const id of Object.keys(next.emptyHomeByTruck)) if (!manual.current.has("emptyHome") && out.perTruck[id]?.home == null) delete next.emptyHomeByTruck[id];
          for (const id of Object.keys(out.perTruck)) {
            const t = out.perTruck[id]!;
            if (t.toPickup != null && !manual.current.has(`empty:${id}`)) next.emptyByTruck[id] = String(roundMiles(t.toPickup + out.emptyMidMiles));
            if (t.home != null && !manual.current.has("emptyHome")) next.emptyHomeByTruck[id] = String(t.home);
          }
          // Empty driving inside the route is never dropped: a truck with no base carries it in the shared pickup figure. A figure typed by hand is left alone.
          if (!manual.current.has("emptyToPickup")) next.emptyToPickup = out.emptyMidMiles > 0 ? String(out.emptyMidMiles) : "";
          return next;
        });
        const trucks = Object.keys(out.perTruck).length;
        setMeasure({
          state: "ok",
          text: `On the road: ${out.loadedMiles.toLocaleString("en-US")} mi loaded, about ${out.loadedHours.toLocaleString("en-US")} h of driving${trucks > 0 ? `; empty miles measured from ${trucks === 1 ? "the truck's base" : `${trucks} trucks' bases`}` : ""}. Type over any figure to use your own.`
        });
      } catch {
        if (mine === measureSeq.current) {
          lastRoute.current = "";
          setMeasure({ state: "error", text: "Could not reach the map. Type the miles, or measure again." });
        }
      }
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeNow, done, remeasure]);

  /**
   * A figure typed by hand is the dispatcher's from then on; blanking it hands it back to the map, which measures the route again. Typing the shared "empty to the pickup" clears
   * the per-truck figures the map measured (as typing "empty home" always did), and keeps the ones typed by hand against a truck.
   */
  const typedMiles = (field: "loadedMiles" | "emptyToPickup" | "emptyHome", v: string) => {
    if (v.trim() === "") {
      manual.current.delete(field);
      lastRoute.current = "";
      setRemeasure((n) => n + 1);
    } else manual.current.add(field);
    setValues((cur) => ({
      ...cur,
      [field]: v,
      ...(field === "loadedMiles" && !manual.current.has("loadedHours") ? { loadedHours: "" } : {}),
      ...(field === "emptyHome" && v.trim() !== "" ? { emptyHomeByTruck: {} } : {}),
      ...(field === "emptyToPickup" && v.trim() !== "" ? { emptyByTruck: Object.fromEntries(Object.entries(cur.emptyByTruck).filter(([id]) => manual.current.has(`empty:${id}`))) } : {})
    }));
  };

  const rows: FitRow[] = priced?.ok ? priced.fit.rows : [];
  const fitTotal = priced?.ok ? priced.fit.total : 0;
  const row =
    rows.find((r) => r.key === selected) ??
    (initial?.vehicleId ? rows.find((r) => r.truckId === initial.vehicleId && (r.driverId ?? "") === (initial.values.driverId ?? "") && !r.blocked) : undefined) ??
    (initial?.vehicleId ? rows.find((r) => r.truckId === initial.vehicleId && !r.blocked) : undefined) ??
    rows.find((r) => !r.blocked) ??
    rows[0] ??
    null;

  const authority = useAuthorityLookup();
  const set = (patch: Partial<QuoteValues>) => setValues((v) => ({ ...v, ...patch }));
  const setStop = (i: number, patch: Partial<QuoteStop>) => setValues((v) => ({ ...v, stops: v.stops.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const addStop = () => setValues((v) => ({ ...v, stops: [...v.stops.slice(0, -1), { role: "delivery", address: "", appointment: "" }, v.stops[v.stops.length - 1]!] }));
  const removeStop = (i: number) => setValues((v) => ({ ...v, stops: v.stops.filter((_, k) => k !== i) }));
  const reset = () => {
    draft.discard();
    setValues(BLANK_QUOTE);
    setReason("");
    setNotes("");
    setPassReason("");
    setPassNotes("");
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

  /** A server call that may not get through: the form stays as it is and the card says so. Null when it did not. */
  async function reach<T>(call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch {
      setBusy(false);
      setMessage(UNREACHABLE);
      return null;
    }
  }

  async function book(override: { reason: string; notes: string } | null) {
    if (!row) return;
    setBusy(true);
    setMessage(null);
    const out = await reach(() => bookQuoteAction(values, { vehicleId: row.truckId, driverId: row.driverId }, override, quoteId));
    if (!out) return;
    setBusy(false);
    if (out.ok) {
      setAsking(false);
      draft.saved();
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
    const out = await reach(() => saveQuoteAction({ ...values, driverId: row?.driverId ?? "" }, quoteId, row?.truckId ?? null));
    if (!out) return;
    setBusy(false);
    if (out.ok) {
      setQuoteId(out.id);
      setMessage(null);
      draft.saved();
      toast({ text: "Quote saved. It is not on the board until you book it.", tone: "ok" });
      // The address now names the quote, so a reload (or a bookmark) opens it, and what is typed from here is kept against it.
      router.replace(`/quote?quote=${out.id}`);
      router.refresh();
    } else {
      setServerErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked, then save it.");
    }
  }

  /** Pass on it: the quote is kept (saved first when it was only typed) with the reason, so the lane and the customer are remembered. */
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
      const saved = await reach(() => saveQuoteAction({ ...values, driverId: row?.driverId ?? "" }, null, row?.truckId ?? null));
      if (!saved) {
        setPassing(false);
        return;
      }
      if (!saved.ok) {
        setBusy(false);
        setPassing(false);
        setServerErrors(saved.errors ?? {});
        setMessage(saved.error ?? "Fix what is marked, then pass on it.");
        return;
      }
      id = saved.id;
      // The quote now exists: a retry after a failed pass uses it instead of saving another copy.
      setQuoteId(saved.id);
    }
    const passed = id;
    const out = await reach(() => passQuoteAction(passed, passReason, passNotes));
    if (!out) {
      setPassing(false);
      return;
    }
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

  const lane = priced?.ok ? priced.fit.lane : null;
  const benchmark: Benchmark = lane ? "lane" : "market";
  const verdict = row ? verdictOf(row, benchmark) : null;
  const bookTo = row ? `${row.truckName}${row.driverName ? ` with ${row.driverName.split(" ")[0]}` : ""}` : "";
  // A load the rules want a reason for says so on the button, before it is pressed.
  const bookLabel = !row ? "Book it" : row.blocked ? `${row.truckName} cannot take it` : row.gate ? "Book with a reason" : `Book on ${bookTo}`;

  /** Below 1100 px the verdict sits under the form; the bar keeps its headline in view and this takes you to the rest. */
  const jumpToVerdict = () =>
    document.getElementById("qt-verdict")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });

  return (
    <>
      <div className="qt-bar" role="group" aria-label="Verdict summary" data-tone={verdict?.tone ?? "none"}>
        {row && verdict ? (
          <>
            <VerdictTag state={verdict.state} word={verdict.word} />
            <strong className="qt-bar-fig">
              {perMile(row.allInPerMile)} <span>all-in</span>
            </strong>
            <span className="qt-bar-fact">
              {row.marginPerMile == null ? `Floor ${perMile(row.floorPerMile)}` : `${row.marginPerMile < 0 ? "Short by" : "Clears by"} ${perMile(Math.abs(row.marginPerMile))}`}
            </span>
            <span className="qt-bar-truck">
              {row.truckName}
              {row.driverName ? ` · ${row.driverName}` : ""}
            </span>
          </>
        ) : (
          <span className="qt-bar-fact">{pricing ? "Pricing…" : "Type the offer and the loaded miles to price it."}</span>
        )}
        <button type="button" className="tl-btn ghost qt-bar-jump" onClick={jumpToVerdict}>
          Verdict
        </button>
      </div>
      <div className="qt">
        <div className="qt-main">
          {!canWrite ? (
            <p className="tl-note warn" role="status">
              You can price a quote here, but saving, booking and passing need dispatcher access. Ask an owner to change your role in Settings.
            </p>
          ) : null}
          {readOnly ? (
            <p className="tl-note warn" role="status">
              This quote was passed on ({initial!.passedFor}). It is kept as it was said. <Link href={`/quote?like=${initial!.id}`}>Quote like this</Link> to start a new one from it.
            </p>
          ) : null}
          {/* The fuel price fills itself, so a form with only that in it is not one anybody was working on. */}
          {JSON.stringify({ ...values, fuelPrice: "" }) !== JSON.stringify({ ...(initial?.values ?? BLANK_QUOTE), fuelPrice: "" }) ? <DraftNote draft={draft} what="this quote" /> : null}
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
                      <DateInput type="datetime-local" value={s.appointment} onChange={(e) => setStop(i, { appointment: e.target.value })} aria-invalid={err(`stop${i}Time`) ? true : undefined} />
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
                Customer
                <input list="qt-brokers" value={values.broker} onChange={(e) => set({ broker: e.target.value })} autoComplete="off" />
                <datalist id="qt-brokers">
                  {brokers.map((b) => (
                    <option key={b.name} value={b.name} />
                  ))}
                </datalist>
                {customer && filledFrom === customer.name ? (
                  <span className="th-hint">{`From ${customer.name}'s record${customer.payTermsDays != null ? `: net ${customer.payTermsDays}` : ""}${customer.mc ? `, MC ${customer.mc}` : ""}. Type over anything.`}</span>
                ) : customer ? (
                  <span className="th-hint">On your customers. Add their MC and terms on their page and they fill in here.</span>
                ) : values.broker.trim() !== "" ? (
                  <span className="th-hint">
                    Not on your customers yet. <Link href="/customers/new">Add them</Link> to fill their MC and terms next time.
                  </span>
                ) : null}
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
              <Money label="Market rate" unit="$ total" value={values.marketRate} error={err("marketRate")} onChange={(v) => set({ marketRate: v })} hint="The total for the load, not per mile. Blank uses your recent loads on this lane, if there are enough." />
              <Money label="Pay terms" unit="days" value={values.payTermsDays} error={err("payTermsDays")} onChange={(v) => set({ payTermsDays: v })} hint="Saved with the load for the invoice. It does not change the verdict." />
              <Money label="Factoring fee" unit="%" value={values.factoringPct} error={err("factoringPct")} onChange={(v) => set({ factoringPct: v })} hint="Blank uses each truck's own." />
              <Money label="Fuel price" unit="$ a gallon" value={values.fuelPrice} error={err("fuelPrice")} onChange={(v) => set({ fuelPrice: v, fuelSource: v.trim() === "" ? "" : "typed" })} hint="Filled with this week's regional price; type over it to use your own. Blank uses each truck's own. For this check only: it is not saved." />
            </div>
            <LiveFuelPrice fuel="diesel" origin={values.stops[0]?.address ?? ""} destination={values.stops[values.stops.length - 1]?.address ?? ""} typed={values.fuelPrice} onUse={(price) => set({ fuelPrice: price, fuelSource: "regional" })} auto autoFilled={values.fuelSource === "regional"} />
            <details className="qt-more" open={paperOpen || undefined} onToggle={(e) => setPaperOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary>Customer paperwork</summary>
              <div className="qt-grid">
                <label className="tl-field">
                  MC number (brokers and carriers)
                  <input
                    value={values.brokerMc}
                    onChange={(e) => {
                      authority.reset();
                      set({ brokerMc: e.target.value });
                    }}
                    onBlur={() => void authority.check(values.brokerMc, values.broker, (name) => setValues((v) => (v.broker.trim() === "" ? { ...v, broker: name } : v)))}
                    inputMode="numeric"
                    autoComplete="off"
                    aria-invalid={err("brokerMc") ? true : undefined}
                  />
                  {err("brokerMc") ? <span className="th-err" role="alert">{err("brokerMc")}</span> : null}
                  <AuthorityStatus busy={authority.busy} result={authority.result} />
                </label>
                <label className="tl-field">
                  Customer&apos;s load number
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
                {measure.state === "error" ? (
                  <>
                    {" "}
                    <button type="button" className="tl-btn ghost sm" onClick={() => setRemeasure((n) => n + 1)}>
                      Measure again
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            <div className="qt-grid">
              <Money label="Loaded" unit="miles" value={values.loadedMiles} error={err("loadedMiles")} onChange={(v) => typedMiles("loadedMiles", v)} />
              <Money label="Empty to the pickup" unit="miles" value={values.emptyToPickup} error={err("emptyToPickup")} onChange={(v) => typedMiles("emptyToPickup", v)} hint="Each truck with a base is measured below." />
              <Money label="Empty home after" unit="miles" value={values.emptyHome} error={err("emptyHome")} onChange={(v) => typedMiles("emptyHome", v)} />
              <Money
                label="Drive time, loaded miles"
                unit="hours"
                value={values.loadedHours}
                error={err("loadedHours")}
                onChange={(v) => {
                  if (v.trim() === "") {
                    manual.current.delete("loadedHours");
                    lastRoute.current = "";
                    setRemeasure((n) => n + 1);
                  } else manual.current.add("loadedHours");
                  set({ loadedHours: v });
                }}
                hint={manual.current.has("loadedHours") ? "Typed by you. Blank hands it back to the map." : values.loadedHours.trim() === "" ? "Blank assumes 50 mph over every mile." : "Measured on the road. Type over it to use your own."}
              />
            </div>
            <div className="th-field qt-after" role="group" aria-label="After the delivery">
              <span className="th-label">After the delivery</span>
              <div className="cp-seg">
                {(
                  [
                    ["home", "Back to the truck's base"],
                    ["load", "A load back covers the way home"],
                    ["elsewhere", "Somewhere else: type the miles"]
                  ] as const
                ).map(([key, text]) => {
                  const now = values.loadBack ? "load" : manual.current.has("emptyHome") ? "elsewhere" : "home";
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={now === key}
                      onClick={() => {
                        if (key === "load") set({ loadBack: true });
                        else {
                          set({ loadBack: false });
                          // Back to the base hands the figure to the map; somewhere else leaves it for you to type.
                          if (key === "home") typedMiles("emptyHome", "");
                          else document.getElementById("qt-empty-home-after")?.focus();
                        }
                      }}>
                      {text}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="tl-card">
            <details className="qt-more qt-advanced" open={advancedOpen || undefined} onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary>
                Other costs and settings <span className="tl-sub">Dock wait, towing, permits, an insurance rider, how wide &ldquo;at market&rdquo; is. The phone counts these in the verdict; blank counts none.</span>
              </summary>
              <div className="qt-grid">
                <Money label="Dock wait" unit="minutes" value={values.dockWaitMinutes} error={err("dockWaitMinutes")} onChange={(v) => set({ dockWaitMinutes: v })} hint="Time at the docks, on the clock." />
                <Money label="Towing or trailer cost" unit="$ a mile" value={values.towingPerMile} error={err("towingPerMile")} onChange={(v) => set({ towingPerMile: v })} hint="Added to the truck's cost a mile." />
                <Money label="Permit or escort" unit="$ for the load" value={values.permitEscort} error={err("permitEscort")} onChange={(v) => set({ permitEscort: v })} hint="Spread over the load's miles." />
                <Money label="Insurance rider" unit="$ for the load" value={values.insuranceRider} error={err("insuranceRider")} onChange={(v) => set({ insuranceRider: v })} hint="Taken out of the pay." />
                <label className="tl-field">
                  How wide is &ldquo;at market&rdquo;
                  <select value={values.marketBand} onChange={(e) => set({ marketBand: e.target.value as QuoteValues["marketBand"] })}>
                    <option value="5">Tight, within 5%</option>
                    <option value="">Usual, within 10%</option>
                    <option value="15">Wide, within 15%</option>
                  </select>
                  <span className="th-hint">Only how it is drawn. The question asked before a low load is booked stays at 10%.</span>
                </label>
              </div>
            </details>
          </section>

          <section className="tl-card">
            <details className="qt-more qt-spec" open={specOpen || undefined} onToggle={(e) => setSpecOpen((e.currentTarget as HTMLDetailsElement).open)}>
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
                  <select value={values.hazmatClass} onChange={(e) => set({ hazmatClass: e.target.value })} aria-invalid={err("hazmatClass") ? true : undefined}>
                    <option value="">Not hazmat</option>
                    {HAZMAT_CLASSES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                    {values.hazmatClass !== "" && !HAZMAT_CLASSES.some((c) => c.value === values.hazmatClass) ? <option value={values.hazmatClass}>{values.hazmatClass}</option> : null}
                  </select>
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
        <section className="qt-fit">
          <div className="rc-list-head">
            <h2 className="rc-eyebrow">Which truck and driver</h2>
            <span className="tl-sub">{pricing ? "Pricing…" : rows.length > 0 ? (fitTotal > rows.length ? `The best ${rows.length} of ${fitTotal} ways to run it, best first` : `${rows.length} ${rows.length === 1 ? "way" : "ways"} to run it, best first`) : ""}</span>
          </div>
          {priced?.ok && (priced.context.passed.lane > 0 || priced.context.passed.broker > 0) ? (
            <p className="tl-note">
              {[priced.context.passed.lane > 0 ? `You have passed on ${priced.context.passed.lane} ${priced.context.passed.lane === 1 ? "quote" : "quotes"} on this lane` : null, priced.context.passed.broker > 0 ? `${priced.context.passed.broker} for this customer` : null].filter(Boolean).join(", and ")}. <Link href="/kpi/quotes?period=all">See the reasons</Link>.
            </p>
          ) : null}
          {rows.length === 0 ? (
            <p className="tl-note">Every truck and driver is priced here once there is an offer and loaded miles.</p>
          ) : (
            <div className="dt-wrap qt-scroll">
              <table className="tl-table qt-table" aria-label="Trucks and drivers">
                <thead>
                  <tr>
                    <th aria-label="Choose" />
                    <th>Truck and driver</th>
                    <th className="num">Empty to pickup</th>
                    <th>Verdict</th>
                    <th className="num">Every mile</th>
                    <th className="num">Left over</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const said = verdictOf(r, benchmark);
                    const on = row?.key === r.key;
                    return (
                      <tr key={r.key} className={`${on ? "qt-on" : ""}${r.blocked ? " qt-off" : ""}`.trim() || undefined} onClick={() => setSelected(r.key)}>
                        <td>
                          <input type="radio" name="qt-pick" checked={on} onChange={() => setSelected(r.key)} aria-label={`Run it on ${r.truckName}${r.driverName ? ` with ${r.driverName}` : ""}`} />
                        </td>
                        <td>
                          <b>{r.truckName}</b>
                          <span className="sub">{r.driverName ? `${r.driverName} · ${shortLabour(r)}` : "No driver set on this truck"}</span>
                          {r.hos.availableHours != null ? <span className="sub">Hours left now: {r.hos.availableHours} h{r.hos.syncedAt ? ` · read ${ago(r.hos.syncedAt)}` : ""}</span> : null}
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
                          <VerdictTag state={said.state} word={said.word} />
                        </td>
                        <td className="num">
                        {perMile(r.allInPerMile)}
                        <span className="sub">{`floor ${perMile(r.floorPerMile)}`}</span>
                      </td>
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
                  {priced.context.lane.averagePerMile != null ? `, averaging ${perMile(priced.context.lane.averagePerMile)} on the loaded miles (its latest 25, any trailer or age)` : ""}.
                </p>
                <table className="tl-table" aria-label="Lane history">
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
            <span className="tl-sub">{list.total === 0 ? "" : `${list.total} ${listStatus === "all" ? "in all" : listStatus}`}</span>
          </div>
          <div className="qt-list-tools">
            <div className="cp-seg" role="group" aria-label="Which quotes">
              {(["open", "passed", "all"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={listStatus === s}
                  onClick={() => {
                    setListStatus(s);
                    refilter(listQuery, s);
                  }}>
                  {s === "open" ? "Open" : s === "passed" ? "Passed" : "All"}
                </button>
              ))}
            </div>
            <input
              className="qt-list-search"
              type="search"
              value={listQuery}
              placeholder="Search a lane, customer, load number or truck"
              aria-label="Search saved quotes"
              onChange={(e) => {
                setListQuery(e.target.value);
                refilter(e.target.value, listStatus);
              }}
            />
          </div>
          {quotes.length === 0 ? (
            <p className="tl-note">{listQuery.trim() !== "" || listStatus !== "open" ? "No quote matches that." : "Nothing saved. A quote you save waits off the board until you book it."}</p>
          ) : (
            <div className="dt-wrap qt-scroll">
              <table className="tl-table" aria-label="Saved quotes">
                <thead>
                  <tr>
                    <th>Lane</th>
                    <th>Customer</th>
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
                              if (!window.confirm(`Throw away the quote for ${q.lane}${q.broker ? ` (${q.broker})` : ""}? It is kept in the audit trail, but it cannot be opened again.`)) return;
                              const out = await reach(() => discardQuoteAction(q.id));
                              if (out?.ok) {
                                if (q.id === quoteId) setQuoteId(null);
                                router.refresh();
                                toast({ text: "Quote discarded.", tone: "ok" });
                              } else if (out) toast({ text: "That quote could not be thrown away. It may already be booked or gone; reload the list.", tone: "bad" });
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
          {list.rows.length < list.total ? (
            <button type="button" className="tl-btn ghost sm" style={{ marginTop: 8 }} onClick={() => refilter(listQuery, listStatus, true)}>
              {`Show more (${list.total - list.rows.length} left)`}
            </button>
          ) : null}
        </section>
        </div>

        <aside id="qt-verdict" className="qt-side" data-readonly={locked ? "true" : undefined} aria-label="The verdict" aria-live="polite" data-tone={verdict?.tone ?? "none"}>
          <div className="qt-glass">
          <h2 className="rc-eyebrow">{row ? `Priced for ${row.truckName}${row.driverName ? ` · ${row.driverName}` : ""}` : "The verdict"}</h2>
          {row && verdict ? <VerdictPanel row={row} verdict={verdict} values={values} lane={lane} milesFrom={manual.current.has("loadedMiles") ? "typed" : measure.state === "ok" || values.loadedHours.trim() !== "" ? "measured" : "typed"} fuelFrom={usedFuel != null ? "typed" : row.detail.fuelPerMile == null ? "none" : "own"} /> : <p className="tl-note">{priceFailed ? "Not priced." : priced && !priced.ok ? "Type the offer and the loaded miles to price it." : pricing ? "Pricing…" : priced?.ok && priced.fit.skipped.length > 0 ? "No truck has a cost profile to price against." : "Type the offer and the loaded miles to price it."}</p>}
          {priceFailed ? (
            <div className="qt-retry" role="alert">
              <p className="tl-note warn">{UNREACHABLE}</p>
              <button type="button" className="tl-btn sm" onClick={() => setPriceAgain((n) => n + 1)}>
                Try again
              </button>
            </div>
          ) : null}
          {priced?.ok && priced.fit.trailersAvailable != null ? (
            <p className="tl-sub" style={{ marginTop: 8 }}>
              {priced.fit.trailersAvailable.toLocaleString("en-US")} {priced.fit.trailersAvailable === 1 ? "trailer is" : "trailers are"} free{values.trailer ? ` of the kind this needs (${values.trailer.replace(/_/g, " ")})` : ""}.
            </p>
          ) : null}
          {priced?.ok && priced.warnings.map((w) => <p key={w} className="tl-note warn">{w}</p>)}
          {priced?.ok && usedFuel != null ? <p className="tl-note">{`Priced with fuel at $${usedFuel.toFixed(2)} a gallon (${values.fuelSource === "regional" ? "this week's regional price" : "typed"}) on diesel trucks, not their own price. It is kept with the quote and written into the booking record.`}</p> : null}
          {message ? (
            <p className="tl-note warn" role="alert">
              {message}
            </p>
          ) : null}
          {row?.blocked ? (
            <p className="tl-note warn">
              {row.truckName}
              {row.driverName ? ` with ${row.driverName}` : ""} cannot take it: {row.blocked} Pick another row.
            </p>
          ) : null}
          {/* The buttons say the verdict too: below cost, passing is the main button and booking asks for a reason, so the card still tells you with every colour taken away. */}
          <div className="qt-actions">
            {verdict?.state === "reject" ? (
              <button type="button" className="tl-btn primary" disabled={busy} onClick={onOpenPass}>
                Reject it
              </button>
            ) : (
              <button type="button" className="tl-btn primary" disabled={busy || !row || !!row.blocked} aria-busy={busy || undefined} onClick={onBook}>
                {bookLabel}
              </button>
            )}
            <div className="qt-actions-row">
              <button type="button" className="tl-btn" disabled={busy} onClick={() => void onSave()}>
                {quoteId ? "Update quote" : "Save as a quote"}
              </button>
              {verdict?.state === "reject" ? (
                <button type="button" className="tl-btn ghost" disabled={busy || !!row?.blocked} aria-busy={busy || undefined} onClick={onBook}>
                  Book anyway
                </button>
              ) : (
                <button type="button" className="tl-btn ghost" disabled={busy || !row} onClick={onOpenPass}>
                  Pass on it
                </button>
              )}
            </div>
          </div>
          </div>
        </aside>
      </div>

      <Modal open={asking} onClose={() => setAsking(false)} eyebrow="Before booking" title={row?.gate ? gateTitle(row.gate, benchmark) : "Book it?"}>
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

      <Modal open={passing} onClose={() => setPassing(false)} eyebrow={verdict?.state === "reject" ? "Reject it" : "Pass on it"} title={verdict?.state === "reject" ? "Why reject this one?" : "Why pass on this one?"}>
        <div className="dlg-form">
          <p className="tl-note">The quote is kept with the reason, so the lane and the customer are remembered.</p>
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
              {verdict?.state === "reject" ? "Reject it" : "Pass on it"}
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

/** What the audited math said about one way of running the load, as a verdict. */
function verdictOf(row: FitRow, benchmark: Benchmark): VerdictRead {
  const d = row.detail;
  return readVerdict({
    band: row.band,
    gate: row.gate,
    allInPerMile: row.allInPerMile,
    floorPerMile: row.floorPerMile,
    marginPerMile: row.marginPerMile,
    leftOver: row.leftOver,
    totalMiles: row.totalMiles,
    gross: d.effectiveGross,
    marketDollars: d.marketVarianceDollars,
    marketPct: d.marketVariancePct,
    benchmark,
    payNeeded: d.payNeeded,
    thinMargin: d.thinMargin,
    timeTrap: d.timeTrap,
    profitPerHour: d.profitPerHour,
    hourlyTarget: d.hourlyTarget
  });
}

/**
 * The card. Its skeleton does not change from load to load or from surface to surface: the word, why, the figure, where the load lands, the working, what it rests on. The verdict
 * itself is data (src/lib/verdict.ts); this only draws it. See docs/VERDICT_CARD.md before changing the order of anything here.
 */
function VerdictPanel({ row, verdict, values, lane, milesFrom, fuelFrom }: { row: FitRow; verdict: VerdictRead; values: QuoteValues; lane: LaneBenchmark | null; milesFrom: "measured" | "typed"; fuelFrom: "own" | "typed" | "none" }) {
  const d = row.detail;
  const home = values.loadBack ? "a load covers the way home" : Number(values.emptyHome) > 0 ? `${miles(Number(values.emptyHome))} empty home` : "no empty miles home";
  const notes: string[] = [];
  if (d.routeMinimum && !d.routeMinimum.meets) notes.push(`The route minimum of ${usd(d.routeMinimum.expected, 0)} is not met.`);
  // Below cost, the sentence already says it, with the money.
  if (d.rejectReason && verdict.state !== "reject") notes.push(d.rejectReason);
  // Thin and slow money are in the sentence when they are the reason; when something else was, they still get said.
  if (d.thinMargin && !verdict.sentence.includes("five cents")) notes.push("It clears, but by less than five cents a mile.");
  if (d.timeTrap && d.profitPerHour != null && !verdict.sentence.includes("an hour against")) notes.push(`Profit per trip hour is ${usd(d.profitPerHour, 2)}, under the ${usd(d.hourlyTarget, 0)} an hour target.`);
  if (d.requiredRests > 0) notes.push(`A run this long needs ${d.requiredRests} ten-hour ${d.requiredRests === 1 ? "rest" : "rests"}: about ${d.elapsedHours.toFixed(0)} hours elapsed.`);
  const ground = groundOf({ miles: milesFrom, fuel: fuelFrom, market: lane ? { laneLoads: lane.loads, laneDays: lane.days } : values.marketRate.trim() === "" ? "none" : "typed", driver: /from this assignment/.test(row.labourNote) });
  const trust = ground.filter((g) => !g.firm);
  return (
    <div className="qt-verdict">
      <VerdictHead verdict={verdict} />
      <div className="qt-big">
        {perMile(row.allInPerMile)} <span>all-in</span>
      </div>
      <p className="tl-note">
        on {miles(row.totalMiles)} · {home}
      </p>
      {verdict.ruler ? <VerdictRuler ruler={verdict.ruler} state={verdict.state} /> : null}
      <dl className="rc-facts">
        <div>
          <dt>Pay with surcharge</dt>
          <dd>{usd(d.effectiveGross, 2)}</dd>
        </div>
        {d.marketVariancePct != null ? (
          <div>
            <dt>{lane ? "Against your lane" : "Against the market"}</dt>
            <dd>
              {d.marketVariancePct >= 0 ? "+" : "−"}
              {Math.abs(d.marketVariancePct * 100).toFixed(1)}%
              {d.marketVarianceDollars != null ? ` (${d.marketVarianceDollars >= 0 ? "+" : "−"}${usd(Math.abs(d.marketVarianceDollars), 0)})` : ""}
            </dd>
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
      {d.routeMinimum ? (
        <p className="tl-note" data-met={d.routeMinimum.meets ? "yes" : "no"}>
          {d.routeMinimum.meets ? `Meets the route minimum of ${usd(d.routeMinimum.expected, 0)}.` : `Under the route minimum of ${usd(d.routeMinimum.expected, 0)}: the pay is ${usd(d.fees.net, 0)} after fees.`}
        </p>
      ) : null}
      <details className="qt-figures">
        <summary>See all the figures</summary>
        <dl className="rc-facts">
          <div>
            <dt>Load rate (loaded miles)</dt>
            <dd>{perMile(d.metrics.loadRpm)}</dd>
          </div>
          <div>
            <dt>Pickup rate (to the pickup too)</dt>
            <dd>{perMile(d.metrics.pickupRpm)}</dd>
          </div>
          <div>
            <dt>Truck cost a mile this load</dt>
            <dd>{perMile(d.metrics.truckCostPerMile)}</dd>
          </div>
          <div>
            <dt>Left after all trip costs</dt>
            <dd className={d.metrics.profitPerMile != null && d.metrics.profitPerMile < 0 ? "neg" : undefined}>{d.metrics.profitPerMile == null ? "—" : `${d.metrics.profitPerMile < 0 ? "−" : ""}${perMile(d.metrics.profitPerMile < 0 ? -d.metrics.profitPerMile : d.metrics.profitPerMile)}`}</dd>
          </div>
          <div>
            <dt>Margin after fuel</dt>
            <dd>{d.metrics.marginAfterFuelPct == null ? "Needs fuel" : `${d.metrics.marginAfterFuelPct < 0 ? "−" : ""}${(d.metrics.marginAfterFuelPct < 0 ? -d.metrics.marginAfterFuelPct : d.metrics.marginAfterFuelPct).toFixed(1)}%`}</dd>
          </div>
          <div>
            <dt>Fuel for the trip</dt>
            <dd>{d.metrics.fuelTotal == null ? "Needs fuel" : usd(d.metrics.fuelTotal, 0)}</dd>
          </div>
          <div>
            <dt>On the clock</dt>
            <dd>{`${d.metrics.tripHours.toFixed(1)} h`}{d.metrics.rph != null ? ` · ${usd(d.metrics.rph, 2)} an hour` : ""}</dd>
          </div>
        </dl>
        <p className="rc-eyebrow">What the pay becomes</p>
        <dl className="rc-facts">
          <div>
            <dt>Pay with surcharge</dt>
            <dd>{usd(d.fees.gross, 2)}</dd>
          </div>
          {d.fees.carrier > 0 ? (
            <div>
              <dt>{`Carrier's cut (${(d.fees.carrierPct * 100).toFixed(0)}%)`}</dt>
              <dd>{`−${usd(d.fees.carrier, 2)}`}</dd>
            </div>
          ) : null}
          {d.fees.factoring > 0 ? (
            <div>
              <dt>{`Factoring (${(d.fees.factoringPct * 100).toFixed(1)}%)`}</dt>
              <dd>{`−${usd(d.fees.factoring, 2)}`}</dd>
            </div>
          ) : null}
          {d.fees.rider > 0 ? (
            <div>
              <dt>Insurance rider</dt>
              <dd>{`−${usd(d.fees.rider, 2)}`}</dd>
            </div>
          ) : null}
          <div>
            <dt>
              <b>Net pay</b>
            </dt>
            <dd>
              <b>{usd(d.fees.net, 2)}</b>
            </dd>
          </div>
        </dl>
      </details>
      {notes.length > 0 ? (
        <ul className="rc-todo qt-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {row.warnings.length > 0 ? (
        <ul className="rc-warns-list">
          {row.warnings.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {/* The lane is paid on its loaded miles and the ruler stands on every mile, so the same lane reads as two figures: say both, or the card seems to disagree with the record below it. */}
      {lane ? <p className="vc-trust">{`Compared with ${ground[2]!.label.toLowerCase()}, as no market rate was typed: ${perMile(lane.perMile)} on the loaded miles${verdict.ruler?.market ? `, ${perMile(verdict.ruler.market.value)} over every mile of this trip` : ""}.`}</p> : null}
      <p className="vc-trust">{trust.length > 0 ? `Taken on trust: ${trust.map((g) => g.label.toLowerCase()).join(", ")}.` : "Every figure here was measured or is on record."}</p>
    </div>
  );
}
