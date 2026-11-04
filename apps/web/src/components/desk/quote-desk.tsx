"use client";

import { findBackhauls, type OpenPickupCandidate } from "@/lib/backhaul-detect";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { bookQuoteAction, discardQuoteAction, listQuotesAction, passQuoteAction, priceQuoteAction, readSampleRateConAction, readUploadedRateConAction, saveQuoteAction, type PricedQuote, type ReadResult } from "@/app/(desk)/actions";
import { rateConDraftToQuote } from "@/lib/rate-con-to-quote";
import { UNREACHABLE } from "@/lib/connection";
import { miles, perMile, shortDate, usd } from "@/lib/desk-format";
import { addressReady, roundMiles } from "@/lib/geo";
import { hosDeficit, hosDeficitLabel, hosDeficitTitle } from "@/lib/hos-deficit";
import { BLANK_QUOTE, gateTitle, grossPerLoadedMile, HAZMAT_CLASSES, isQuoteDirty, missingTimes, OVERRIDE_REASONS, PASS_REASONS, quoteCautions, readQuote, swapRoute, validateQuote, type QuoteStop, type QuoteValues } from "@/lib/quote";
import { BRIEF_LABEL, buildBrief, type BriefKind } from "@/lib/quote-brief";
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
import { parseBrokerSnippet } from "@/lib/quote-parser";
import "./quote-terminal.css";

/** How long ago an ISO time was, in the unit that reads best: "3 min ago", "2 h ago", "1 d ago". */
const ago = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return min < 90 ? `${min} min ago` : min < 60 * 36 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
};

type Initial = { id: string | null; values: QuoteValues; vehicleId: string | null; /** Why it was passed on, when it was: the quote is then read, not edited. */ passedFor: string | null } | null;

/** What the form held before Clear or a swap, kept for a few seconds behind an Undo. */
type Snap = { values: QuoteValues; quoteId: string | null; selected: string | null; reason: string; notes: string; lastRoute: string; measure: { state: "idle" | "busy" | "ok" | "error"; text: string } };

export type FleetTruckOption = {
  id: string;
  name: string;
  type: string | null;
  terminal: string | null;
  homeBaseAddress: string | null;
  hasCostProfile: boolean;
  drivers: Array<{ id: string; name: string }>;
};

/**
 * High-Speed Industrial Quoting Terminal for TrueLane Dispatchers.
 * Function-first, cockpit workstation mirroring the mobile app's core calculation engine:
 * - Two-pane resizable layout (Route/Deal entry on left, Fleet matrix & Verdict on right).
 * - Instant Quick-Paste broker text parser (extracts origin, dest, rate, weight, trailer, MC).
 * - Live Counter-Offer Negotiation Assistant (break-even, +10% target, +15% target, +$50/+$100/+$250 steppers).
 * - Complete keyboard navigation (Ctrl+Enter to book, Ctrl+S to save, Alt+P to pass, 1-9 to select truck).
 */
export function QuoteDesk({
  quotes: firstPage,
  brokers,
  initial,
  canWrite,
  fleet = [],
  openPickups = []
}: {
  quotes: { rows: QuoteListRow[]; total: number };
  brokers: CustomerOption[];
  initial: Initial;
  canWrite: boolean;
  fleet?: FleetTruckOption[];
  openPickups?: OpenPickupCandidate[];
}) {
  const router = useRouter();
  const toast = useToast();

  // View mode: Quoting Terminal vs. Saved Quotes
  const [viewMode, setViewMode] = React.useState<"terminal" | "saved">("terminal");

  // Fleet Matrix sort mode: Closest deadhead vs best margin
  const [matrixSort, setMatrixSort] = React.useState<"margin" | "deadhead">("deadhead");
  const [matrixOpen, setMatrixOpen] = React.useState(true);

  // Draggable resizer state for entry vs eval panes (persisted in localStorage)
  const [entryWidth, setEntryWidth] = React.useState<number>(540);
  const [isResizing, setIsResizing] = React.useState(false);

  // Quick-Paste modal state
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState("");
  const [readingRateCon, setReadingRateCon] = React.useState(false);
  const [draggingFile, setDraggingFile] = React.useState(false);
  const rateConInputRef = React.useRef<HTMLInputElement>(null);

  // Keyboard shortcuts modal state
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // Copy Brief, when the browser will not copy: the text opens in a dialog, selected, to copy by hand.
  const [briefFallback, setBriefFallback] = React.useState<{ label: string; text: string } | null>(null);

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

  // What is typed here is kept until the person saves, books or starts over
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

  // Miles the map filled in are suggestions: a field somebody typed in is theirs
  const manual = React.useRef(new Set<string>(initial?.values.manual ?? []));
  const measureSeq = React.useRef(0);
  const [remeasure, setRemeasure] = React.useState(0);
  const routeKey = (stops: QuoteStop[]) => stops.map((s) => `${s.role}|${s.address.trim().toLowerCase()}`).join("~");
  const lastRoute = React.useRef(initial ? routeKey(initial.values.stops) : "");
  const [measure, setMeasure] = React.useState<{ state: "idle" | "busy" | "ok" | "error"; text: string }>({ state: "idle", text: "" });

  const resumed = React.useRef(false);
  React.useLayoutEffect(() => {
    if (resumed.current || !draft.kept) return;
    resumed.current = true;
    manual.current = new Set(values.manual);
    lastRoute.current = routeKey(values.stops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.kept]);

  React.useEffect(() => {
    const now = [...manual.current].sort();
    if (JSON.stringify(now) !== JSON.stringify([...(values.manual ?? [])].sort())) setValues((v) => ({ ...v, manual: now }));
  }, [values, setValues]);

  // Load persisted entry width
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem("tl_qt_entry_w");
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (parsed >= 380 && parsed <= 900) setEntryWidth(parsed);
      }
    } catch {
      // ignore
    }
  }, []);

  // Split-resizer mouse drag handlers
  const startResizing = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  React.useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: MouseEvent) => {
      const container = document.getElementById("qt-workspace");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newWidth = Math.max(380, Math.min(rect.width - 420, e.clientX - rect.left));
      setEntryWidth(newWidth);
    };
    const handleUp = () => {
      setIsResizing(false);
      try {
        localStorage.setItem("tl_qt_entry_w", String(entryWidth));
      } catch {
        // ignore
      }
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isResizing, entryWidth]);

  // Collapsible groups
  const paperFilled = (v: QuoteValues) => [v.brokerMc, v.loadNumber, v.poNumber, v.brokerPhone, v.brokerEmail].some((x) => (x ?? "").trim() !== "");
  const [paperOpen, setPaperOpen] = React.useState(() => !!initial && paperFilled(initial.values));
  React.useEffect(() => {
    if (paperFilled(values)) setPaperOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.brokerMc, values.loadNumber, values.poNumber, values.brokerPhone, values.brokerEmail]);

  const advancedFilled = (v: QuoteValues) => [v.dockWaitMinutes, v.towingPerMile, v.permitEscort, v.insuranceRider, v.marketBand].some((x) => (x ?? "").trim() !== "") || ((v.loadedHours ?? "").trim() !== "" && manual.current.has("loadedHours"));
  const [advancedOpen, setAdvancedOpen] = React.useState(() => !!initial && advancedFilled(initial.values));
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

  // Backhaul discovery: detect open pickups near the delivery destination
  const lastStop = values.stops[values.stops.length - 1];
  const backhauls = React.useMemo(() => {
    if (!lastStop?.address.trim()) return { count: 0, nearestMiles: null, matches: [] };
    return findBackhauls({ address: lastStop.address }, openPickups);
  }, [lastStop?.address, openPickups]);

  const check = validateQuote(values);
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

  const usedFuel = readQuote(values)?.fuelPrice ?? null;
  const cautions = React.useMemo(() => {
    const input = readQuote(values);
    return input ? quoteCautions(input) : {};
  }, [values]);
  const errors: Record<string, string> = { ...serverErrors, ...(tried && !check.ok ? check.errors : {}) };

  React.useEffect(() => {
    setServerErrors({});
    setMessage(null);
  }, [values]);

  // Price as you type
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

  // Measure on the road
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
          for (const id of Object.keys(next.emptyByTruck)) if (!manual.current.has(`empty:${id}`) && out.perTruck[id]?.toPickup == null) delete next.emptyByTruck[id];
          for (const id of Object.keys(next.emptyHomeByTruck)) if (!manual.current.has("emptyHome") && out.perTruck[id]?.home == null) delete next.emptyHomeByTruck[id];
          for (const id of Object.keys(out.perTruck)) {
            const t = out.perTruck[id]!;
            if (t.toPickup != null && !manual.current.has(`empty:${id}`)) next.emptyByTruck[id] = String(roundMiles(t.toPickup + out.emptyMidMiles));
            if (t.home != null && !manual.current.has("emptyHome")) next.emptyHomeByTruck[id] = String(t.home);
          }
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
    }, 450);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeNow, remeasure, done]);

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

  const rows: FitRow[] = React.useMemo(() => (priced?.ok ? priced.fit.rows : []), [priced]);
  const fitTotal = priced?.ok ? priced.fit.total : 0;

  // Sorted rows based on user preference: closest deadhead vs best margin
  const displayRows = React.useMemo(() => {
    if (rows.length === 0) return [];
    const list = [...rows];
    if (matrixSort === "deadhead") {
      return list.sort((a, b) => {
        const aEmpty = Number(values.emptyByTruck[a.truckId] ?? a.emptyToPickup ?? 0);
        const bEmpty = Number(values.emptyByTruck[b.truckId] ?? b.emptyToPickup ?? 0);
        return aEmpty - bEmpty;
      });
    }
    return list;
  }, [rows, matrixSort, values.emptyByTruck]);

  // Unpriced fleet options (shown when offer/loaded miles are not yet priced)
  const unpricedFleet = React.useMemo(() => {
    if (fleet.length === 0) return [];
    return [...fleet].sort((a, b) => {
      const aEmpty = Number(values.emptyByTruck[a.id] ?? (values.emptyToPickup || 9999));
      const bEmpty = Number(values.emptyByTruck[b.id] ?? (values.emptyToPickup || 9999));
      return aEmpty - bEmpty;
    });
  }, [fleet, values.emptyByTruck, values.emptyToPickup]);

  const row =
    displayRows.find((r) => r.key === selected) ??
    (initial?.vehicleId ? displayRows.find((r) => r.truckId === initial.vehicleId && (r.driverId ?? "") === (initial.values.driverId ?? "") && !r.blocked) : undefined) ??
    (initial?.vehicleId ? displayRows.find((r) => r.truckId === initial.vehicleId && !r.blocked) : undefined) ??
    displayRows.find((r) => !r.blocked) ??
    displayRows[0] ??
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

  // Clear and the swap can be taken back: what the form held is kept for a few seconds behind an Undo.
  const snapshot = (): Snap => ({ values, quoteId, selected, reason, notes, lastRoute: lastRoute.current, measure });
  const restore = (snap: Snap) => {
    // A measure still on its way for the form as it is now must not land on the form as it was.
    measureSeq.current += 1;
    manual.current = new Set(snap.values.manual);
    // A snapshot taken mid-measure has no answer coming any more: measure that route again rather than sit on "Measuring" for good.
    const measuring = snap.measure.state === "busy";
    lastRoute.current = measuring ? "" : snap.lastRoute;
    setMeasure(measuring ? { state: "idle", text: "" } : snap.measure);
    setValues(snap.values);
    setQuoteId(snap.quoteId);
    setSelected(snap.selected);
    setReason(snap.reason);
    setNotes(snap.notes);
  };

  /** Clear, with an Undo. A form with nothing in it is just cleared. `reset` itself is left as it was: Pass and "Quote another" use it too. */
  const clearWithUndo = () => {
    if (!isQuoteDirty(values, BLANK_QUOTE) && quoteId == null) {
      reset();
      return;
    }
    const snap = snapshot();
    reset();
    toast({ text: "Cleared the quote.", ms: 8000, action: { label: "Undo", run: () => restore(snap) } });
  };

  /** Pickup and delivery swapped (the whole run reverses if there are stops between). The times stay in their places; the empty miles are measured again. */
  const swapStops = () => {
    if (locked || values.stops.length < 2) return;
    const snap = snapshot();
    const next = swapRoute(values);
    const clearedTyped = next.manual.length !== values.manual.length;
    measureSeq.current += 1;
    manual.current = new Set(next.manual);
    setValues(next);
    toast({
      text: clearedTyped ? "Swapped pickup and delivery. The empty miles you typed were cleared and will be measured again." : "Swapped pickup and delivery. Empty miles will be measured again.",
      ms: 8000,
      action: { label: "Undo", run: () => restore(snap) }
    });
  };

  // The fast way through a quote: Enter moves on to the next of Pickup, Delivery, Offer and Loaded miles, then to the Book button. Focus only; nothing is pressed.
  const focusAddress = (n: number) => document.querySelector<HTMLElement>(`input[aria-label="Stop ${n} address"]`)?.focus();
  const focusId = (id: string) => document.getElementById(id)?.focus();
  const focusDone = () => document.querySelector<HTMLElement>(".qt-actions button:not([disabled])")?.focus();

  async function reach<T>(call: () => Promise<T>): Promise<T | null> {
    try {
      return await call();
    } catch {
      setBusy(false);
      setMessage(UNREACHABLE);
      return null;
    }
  }

  const book = React.useCallback(async (override: { reason: string; notes: string } | null) => {
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
  }, [row, values, quoteId, draft, router]);

  const onBook = React.useCallback(() => {
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
  }, [check.ok, values.stops, row?.gate, book]);

  const onSave = React.useCallback(async () => {
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
      router.replace(`/quote?quote=${out.id}`);
      router.refresh();
    } else {
      setServerErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked, then save it.");
    }
  }, [check.ok, values, row?.driverId, row?.truckId, quoteId, draft, toast, router]);

  const onOpenPass = React.useCallback(() => {
    setTried(true);
    if (!check.ok) {
      setMessage("Fix what is marked, then pass on it.");
      return;
    }
    setPassReason("");
    setPassNotes("");
    setPassing(true);
  }, [check.ok]);

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

  // Quick-Paste Broker Parser handler
  const handleApplyPaste = () => {
    const parsed = parseBrokerSnippet(pasteText);
    const updates: Partial<QuoteValues> = {};
    let appliedCount = 0;

    if (parsed.origin || parsed.destination) {
      const newStops = [...values.stops];
      if (parsed.origin && newStops[0]) {
        newStops[0] = { ...newStops[0], address: parsed.origin };
        appliedCount++;
      }
      if (parsed.destination && newStops[newStops.length - 1]) {
        newStops[newStops.length - 1] = { ...newStops[newStops.length - 1], address: parsed.destination };
        appliedCount++;
      }
      updates.stops = newStops;
    }

    if (parsed.offer) {
      updates.offer = parsed.offer;
      appliedCount++;
    }
    if (parsed.weightLbs) {
      updates.weightLbs = parsed.weightLbs;
      appliedCount++;
    }
    if (parsed.trailer) {
      updates.trailer = parsed.trailer;
      appliedCount++;
    }
    if (parsed.brokerMc) {
      updates.brokerMc = parsed.brokerMc;
      appliedCount++;
    }
    if (parsed.poNumber) {
      updates.poNumber = parsed.poNumber;
      appliedCount++;
    }
    if (parsed.loadNumber) {
      updates.loadNumber = parsed.loadNumber;
      appliedCount++;
    }

    if (appliedCount > 0) {
      set(updates);
      toast({
        text: `Extracted ${appliedCount} load fields from text.`,
        tone: "ok"
      });
      setPasteOpen(false);
      setPasteText("");
    } else {
      toast({
        text: "Could not detect load fields. Make sure origin, destination, or rate are present.",
        tone: "bad"
      });
    }
  };

  // Rate Confirmation File Ingestion (L1)
  const handleRateConFile = async (file: File) => {
    setReadingRateCon(true);
    try {
      const snap = snapshot();
      let res: ReadResult;
      if (/RC-[A-Z]+-\d+/i.test(file.name)) {
        res = await readSampleRateConAction(file.name);
      } else {
        const form = new FormData();
        form.set("file", file);
        res = await readUploadedRateConAction(form);
      }
      if (res.ok) {
        const mapped = rateConDraftToQuote(res.draft, values);
        setValues(mapped.values);
        manual.current = new Set(mapped.values.manual);
        measureSeq.current += 1;
        toast({
          text: `Loaded ${file.name} (${mapped.filledCount} fields filled).`,
          ms: 8000,
          action: { label: "Undo", run: () => { restore(snap); } }
        });
      } else {
        const msg = res.reason === "no_key"
          ? "No Anthropic API key configured for live extraction. You can test with sample files like RC-AFB-482913.pdf."
          : `Could not read that document (${res.reason}).`;
        toast({ text: msg, tone: "bad" });
      }
    } catch {
      toast({ text: "Could not process rate confirmation file.", tone: "bad" });
    } finally {
      setReadingRateCon(false);
    }
  };

  const handleSampleRateCon = async (sampleName: string) => {
    setReadingRateCon(true);
    try {
      const snap = snapshot();
      const res = await readSampleRateConAction(sampleName);
      if (res.ok) {
        const mapped = rateConDraftToQuote(res.draft, values);
        setValues(mapped.values);
        manual.current = new Set(mapped.values.manual);
        measureSeq.current += 1;
        toast({
          text: `Loaded sample ${sampleName} (${mapped.filledCount} fields filled).`,
          ms: 8000,
          action: { label: "Undo", run: () => { restore(snap); } }
        });
      } else {
        toast({ text: `Could not read sample (${res.reason}).`, tone: "bad" });
      }
    } catch {
      toast({ text: "Could not read sample rate confirmation.", tone: "bad" });
    } finally {
      setReadingRateCon(false);
    }
  };

  // Copy Brief: three texts for three readers (lib/quote-brief.ts). Only the dispatch note carries our truck and our margin.
  const copyBrief = async (kind: BriefKind) => {
    const text = buildBrief(kind, {
      stops: values.stops,
      loadedMiles: values.loadedMiles,
      weightLbs: values.weightLbs,
      trailer: values.trailer,
      offer: values.offer,
      customer: values.broker,
      loadNumber: values.loadNumber,
      poNumber: values.poNumber,
      internal: row ? { truckName: row.truckName, allInPerMile: row.allInPerMile, marginPerMile: row.marginPerMile } : undefined
    });
    try {
      await navigator.clipboard.writeText(text);
      toast({ text: `Copied the ${BRIEF_LABEL[kind].toLowerCase()}.`, tone: "ok" });
    } catch {
      setBriefFallback({ label: BRIEF_LABEL[kind], text });
    }
  };

  // Keyboard navigation shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        onBook();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void onSave();
        return;
      }
      if (e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        onOpenPass();
        return;
      }

      if (isInput) return;

      if (e.shiftKey && e.key.toUpperCase() === "P") {
        e.preventDefault();
        setPasteOpen(true);
        return;
      }
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (rows[idx]) {
          setSelected(rows[idx].key);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, check, row, onBook, onSave, onOpenPass]);

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
  const verdict = row ? verdictOf(row, benchmark, Boolean(cautions.marketRate)) : null;
  const bookTo = row ? `${row.truckName}${row.driverName ? ` with ${row.driverName.split(" ")[0]}` : ""}` : "";
  const bookLabel = !row ? "Book it" : row.blocked ? `${row.truckName} cannot accept this load` : row.gate ? "Book with a reason" : `Book on ${bookTo}`;

  // Counter-offer stepper and target handlers
  const currentOfferNum = Number(values.offer) || 0;
  const handleApplyCounter = (val: number) => {
    set({ offer: String(val) });
    toast({ text: `Offer updated to $${val.toLocaleString()}`, tone: "ok" });
  };
  const handleStepOffer = (delta: number) => {
    const updated = Math.max(0, currentOfferNum + delta);
    set({ offer: String(updated) });
  };

  /** Below 1100 px the verdict sits under the form; the bar keeps its headline in view and this takes you to the rest. */
  const jumpToVerdict = () => {
    if (typeof window !== "undefined" && window.innerWidth <= 1100) {
      document.getElementById("qt-verdict")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start"
      });
    } else {
      const evalPane = document.querySelector(".qt-pane-eval");
      if (evalPane) evalPane.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <div className="qt-cockpit">
      {/* ── Top Command Bar ──────────────────────────────────────────────────────── */}
      <div className="qt-cmd-strip">
        <div className="qt-cmd-tabs" role="tablist" aria-label="Quoting view">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "terminal"}
            className="qt-cmd-tab"
            onClick={() => setViewMode("terminal")}>
            <Icon name="calculator" size={15} />
            <span>Quoting Terminal</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "saved"}
            className="qt-cmd-tab"
            onClick={() => setViewMode("saved")}>
            <Icon name="document" size={15} />
            <span>Saved Quotes {list.total > 0 ? `(${list.total})` : ""}</span>
          </button>
        </div>

        <div className="qt-cmd-actions">
          <button
            type="button"
            className="tl-btn sm"
            onClick={() => setPasteOpen(true)}
            title="Paste load text from email, DAT, or chat (Shift+P)">
            <Icon name="message" size={14} />
            <span>Quick-Paste</span>
          </button>

          <button
            type="button"
            className="tl-btn ghost sm"
            disabled={readingRateCon}
            onClick={() => rateConInputRef.current?.click()}
            title="Upload or drop a rate confirmation PDF or image to fill this quote">
            <Icon name="document" size={14} />
            <span>{readingRateCon ? "Reading PDF…" : "Rate-Con PDF"}</span>
          </button>
          <input
            ref={rateConInputRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleRateConFile(f);
              e.target.value = "";
            }}
          />

          <details className="menu qt-brief">
            <summary className="tl-btn ghost sm" title="Copy a ready-written brief of this quote">
              <Icon name="copy" size={14} />
              <span>Copy Brief</span>
            </summary>
            <div
              className="menu-pop"
              onClick={(e) => {
                const menu = e.currentTarget.closest("details");
                if (menu) menu.open = false;
              }}>
              {(["customer", "driver", "dispatch"] as const).map((kind) => (
                <button key={kind} type="button" title={kind === "dispatch" ? "Includes our truck and margin. For the team, not the customer." : undefined} onClick={() => void copyBrief(kind)}>
                  {BRIEF_LABEL[kind]}
                </button>
              ))}
            </div>
          </details>

          <button
            type="button"
            className="tl-btn ghost sm"
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts (?)">
            <Icon name="help" size={14} />
          </button>

          <button
            type="button"
            className="tl-btn ghost sm"
            onClick={clearWithUndo}
            title="Clear form and start a new quote (Undo stays for a few seconds)">
            Clear
          </button>
        </div>
      </div>

      <div className="qt-bar">
        {row && verdict ? (
          <>
            <span className="qt-bar-word" data-tone={verdict.tone}>{verdict.word}</span>
            <span className="qt-bar-fact">{perMile(row.allInPerMile)} all-in</span>
            <span className="qt-bar-fact">{verdict.sentence}</span>
          </>
        ) : (
          <span className="qt-bar-fact">{pricing ? "Pricing…" : "Type the offer and the loaded miles to price it."}</span>
        )}
        <button type="button" className="tl-btn ghost qt-bar-jump" onClick={jumpToVerdict}>
          Verdict
        </button>
      </div>

      <div className="qt">
        {/* ── View 1: Saved Quotes List (Full Width) ─────────────────────────────── */}
        {viewMode === "saved" ? (
        <section className="qt-quotes" style={{ marginTop: 0 }}>
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
      ) : (
        /* ── View 2: Split Quoting Terminal (Cockpit Mode) ──────────────────────── */
        <div id="qt-workspace" className="qt-workspace">
          {/* ── Left Pane: Load Details & Deal Entry ────────────────────────────── */}
          <div
            className="qt-pane-entry"
            style={{ width: `${entryWidth}px` }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setDraggingFile(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDraggingFile(false);
              }
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                e.preventDefault();
                setDraggingFile(false);
                const file = e.dataTransfer.files[0];
                if (file) void handleRateConFile(file);
              }
            }}>
            {draggingFile ? (
              <div className="qt-drop-overlay">
                <Icon name="document" size={32} />
                <b>Drop rate confirmation PDF here</b>
                <span>Fills stops, offer, equipment and references</span>
              </div>
            ) : null}
            {!canWrite ? (
              <p className="tl-note warn" role="status">
                You can price a quote here, but saving, booking and passing need a dispatcher role. Ask an admin to change your role in Settings.
              </p>
            ) : null}
            {readOnly ? (
              <p className="tl-note warn" role="status">
                This quote was passed on ({initial!.passedFor}). It is kept as it was said. <Link href={`/quote?like=${initial!.id}`}>Quote like this</Link> to start a new one from it.
              </p>
            ) : null}

            {isQuoteDirty(values, initial?.values ?? BLANK_QUOTE) ? <DraftNote draft={draft} what="this quote" /> : null}

            {/* 1. Route Section */}
            <section className="tl-card">
              <h2>Route</h2>
              {err("stops") ? <p className="th-err" role="alert">{err("stops")}</p> : null}
              <ol className="qt-stops">
                {values.stops.map((s, i) => {
                  const first = i === 0;
                  const last = i === stopCount - 1;
                  return (
                    <React.Fragment key={i}>
                      <li className="qt-stop">
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
                          <AddressInput
                            label={`Stop ${i + 1} address`}
                            value={s.address}
                            placeholder={first ? "Dallas, TX" : last ? "Atlanta, GA" : "City, ST"}
                            onChange={(text) => setStop(i, { address: text })}
                            onEnter={() => (last ? focusId("qt-offer") : focusAddress(i + 2))}
                            invalid={!!err(`stop${i}`)}
                          />
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
                      {first && stopCount >= 2 ? (
                        <li className="qt-swap">
                          <button type="button" className="tl-btn ghost sm" aria-label="Swap pickup and delivery" title="Swap pickup and delivery" disabled={locked} onClick={swapStops}>
                            <Icon name="swap" size={14} />
                          </button>
                        </li>
                      ) : null}
                    </React.Fragment>
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

            {/* 2. The Deal Section */}
            <section className="tl-card">
              <h2>The deal</h2>
              <div className="qt-grid">
                <label className="tl-field th-field">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>Customer</span>
                    {customer?.slowPay?.overdueCount ? (
                      <span className="tl-chip bad" title={`${customer.slowPay.overdueCount} invoice(s) past due (${customer.slowPay.overdueBalance.toLocaleString()})`}>
                        {customer.slowPay.overdueCount} overdue (${customer.slowPay.overdueBalance.toLocaleString()})
                      </span>
                    ) : customer?.slowPay?.isSlowPay ? (
                      <span className="tl-chip warn" title={`Takes an average of ${customer.slowPay.avgDaysToPay} days to pay`}>
                        Slow pay (avg {customer.slowPay.avgDaysToPay}d)
                      </span>
                    ) : customer?.slowPay?.avgDaysToPay != null ? (
                      <span className="tl-chip ok" title={`Average pay time: ${customer.slowPay.avgDaysToPay} days`}>
                        Avg {customer.slowPay.avgDaysToPay}d pay
                      </span>
                    ) : null}
                  </div>
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
                <Money label="Offer" unit="$" value={values.offer} error={err("offer")} onChange={(v) => set({ offer: v })} note={grossNote(values.offer, values.loadedMiles)} onEnter={() => focusId("qt-loaded")} />
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
                <Money label="Market rate" unit="$ total" value={values.marketRate} error={err("marketRate")} caution={cautions.marketRate} onChange={(v) => set({ marketRate: v })} hint="Blank uses recent lane history." />
                <Money label="Pay terms" unit="days" value={values.payTermsDays} error={err("payTermsDays")} onChange={(v) => set({ payTermsDays: v })} hint="Saved with the load for invoice." />
                <Money label="Factoring fee" unit="%" value={values.factoringPct} error={err("factoringPct")} caution={cautions.factoringPct} onChange={(v) => set({ factoringPct: v })} hint="Blank uses truck's own." />
                <Money label="Fuel price" unit="$ a gallon" value={values.fuelPrice} error={err("fuelPrice")} onChange={(v) => set({ fuelPrice: v, fuelSource: v.trim() === "" ? "" : "typed" })} hint="Filled with weekly price." />
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

            {/* 3. Miles Section */}
            <section className="tl-card">
              <h2>Miles & Deadhead</h2>
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
                <Money label="Loaded" unit="miles" value={values.loadedMiles} error={err("loadedMiles")} onChange={(v) => typedMiles("loadedMiles", v)} onEnter={focusDone} />
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
                  hint={manual.current.has("loadedHours") ? "Typed by you. Blank hands to map." : values.loadedHours.trim() === "" ? "Blank assumes 50 mph." : "Measured on road."}
                />
              </div>
              <div className="th-field qt-after" role="group" aria-label="After the delivery">
                <span className="th-label">After the delivery</span>
                <div className="cp-seg">
                  {(
                    [
                      ["home", "Back to truck's base"],
                      ["load", "A load back covers home"],
                      ["elsewhere", "Somewhere else (type miles)"]
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

              {/* Quick Deadhead by Base chips */}
              {fleet.length > 0 ? (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--db-border-soft)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--db-fg-dim)" }}>
                      Fleet Deadhead to Pickup
                    </span>
                    <span style={{ fontSize: 11, color: "var(--db-accent-fg)", fontWeight: 500 }}>
                      {values.stops[0]?.address ? `Pickup: ${values.stops[0].address}` : "Enter pickup address"}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {fleet.map((t) => {
                      const deadhead = values.emptyByTruck[t.id] ?? (values.emptyToPickup || null);
                      const isSelected = row?.truckId === t.id || (selected ? selected.startsWith(t.id) : initial?.vehicleId === t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className="tl-btn ghost sm"
                          style={{
                            fontSize: 11,
                            padding: "4px 8px",
                            borderColor: isSelected ? "var(--db-accent)" : undefined,
                            background: isSelected ? "var(--db-bg-card)" : undefined
                          }}
                          onClick={() => {
                            if (priced?.ok) {
                              const match = rows.find((r) => r.truckId === t.id);
                              if (match) setSelected(match.key);
                              else setSelected(`${t.id}:none`);
                            } else {
                              setSelected(`${t.id}:none`);
                            }
                          }}>
                          <b>{t.name}</b>
                          <span style={{ color: "var(--db-fg-dim)", marginLeft: 4 }}>({t.homeBaseAddress || "Base"}):</span>
                          <b style={{ color: "var(--db-accent-fg)", marginLeft: 4 }}>{deadhead != null && deadhead !== "" ? `${deadhead} mi` : "unmeasured"}</b>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </section>

            {/* 4. Equipment Specs & Advanced Section */}
            <section className="tl-card">
              <details className="qt-more qt-spec" open={specOpen || undefined} onToggle={(e) => setSpecOpen((e.currentTarget as HTMLDetailsElement).open)}>
                <summary>
                  Load specs & equipment <span className="tl-sub">Weight, size, trailer, accessorials.</span>
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
                  </label>
                </div>
                <div className="qt-needs">
                  <label className="tl-check">
                    <input type="checkbox" checked={values.requiresLiftgate} onChange={(e) => set({ requiresLiftgate: e.target.checked })} /> Liftgate needed
                  </label>
                  <label className="tl-check">
                    <input type="checkbox" checked={values.requiresRamp} onChange={(e) => set({ requiresRamp: e.target.checked })} /> Ramp needed
                  </label>
                  <label className="tl-check">
                    <input type="checkbox" checked={values.requiresPalletJack} onChange={(e) => set({ requiresPalletJack: e.target.checked })} /> Pallet jack needed
                  </label>
                </div>
              </details>

              <details className="qt-more qt-advanced" open={advancedOpen || undefined} onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)} style={{ marginTop: 12 }}>
                <summary>
                  Other costs & tolerances <span className="tl-sub">Dock wait, towing, permits, insurance rider.</span>
                </summary>
                <div className="qt-grid">
                  <Money label="Dock wait" unit="minutes" value={values.dockWaitMinutes} error={err("dockWaitMinutes")} onChange={(v) => set({ dockWaitMinutes: v })} hint="Time at the docks." />
                  <Money label="Towing or trailer cost" unit="$ a mile" value={values.towingPerMile} error={err("towingPerMile")} onChange={(v) => set({ towingPerMile: v })} hint="Added to truck's CPM." />
                  <Money label="Permit or escort" unit="$ for the load" value={values.permitEscort} error={err("permitEscort")} onChange={(v) => set({ permitEscort: v })} hint="Spread over miles." />
                  <Money label="Insurance rider" unit="$ for the load" value={values.insuranceRider} error={err("insuranceRider")} onChange={(v) => set({ insuranceRider: v })} hint="Deducted from pay." />
                </div>
              </details>
            </section>
          </div>

          {/* ── Draggable Divider ─────────────────────────────────────────────── */}
          <div
            className="qt-resizer"
            data-active={isResizing ? "true" : undefined}
            onMouseDown={startResizing}
            title="Drag to resize panels"
          />

          {/* ── Right Pane: Fleet Evaluation Matrix & Verdict Terminal ────────── */}
          <div className="qt-pane-eval">
            {/* 1. Fleet Comparison Matrix */}
            <div className="qt-matrix-wrap">
              <div className="qt-matrix-head">
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <h3 style={{ margin: 0, fontSize: "var(--db-text-sm)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Which truck & driver
                  </h3>
                  <div className="cp-seg" role="group" aria-label="Sort matrix">
                    <button
                      type="button"
                      aria-pressed={matrixSort === "deadhead"}
                      onClick={() => setMatrixSort("deadhead")}>
                      Closest (Deadhead)
                    </button>
                    <button
                      type="button"
                      aria-pressed={matrixSort === "margin"}
                      onClick={() => setMatrixSort("margin")}>
                      Best Margin
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="tl-sub">
                    {pricing ? "Pricing…" : rows.length > 0 ? (matrixSort === "deadhead" ? `${displayRows.length} ranked by deadhead` : `${displayRows.length} ranked by margin`) : `${unpricedFleet.length} in fleet, closest first`}
                  </span>
                  <button
                    type="button"
                    className="tl-btn ghost sm"
                    style={{ padding: "2px 8px", fontSize: 11 }}
                    onClick={() => setMatrixOpen((o) => !o)}
                    aria-label={matrixOpen ? "Minimize fleet table" : "Expand fleet table"}>
                    {matrixOpen ? "Minimize" : "Expand"}
                  </button>
                </div>
              </div>
              {!matrixOpen ? (
                <div className="qt-matrix-collapsed-strip" role="group" aria-label="Quick truck picker">
                  {(rows.length > 0 ? displayRows : unpricedFleet).map((item, idx) => {
                    const isFit = "truckId" in item;
                    const truckId = isFit ? item.truckId : item.id;
                    const truckName = isFit ? item.truckName : item.name;
                    const dh = values.emptyByTruck[truckId] || values.emptyToPickup || "0";
                    const isSelected = isFit ? row?.key === item.key : selected ? selected.startsWith(item.id) : (initial?.vehicleId === item.id || idx === 0);
                    return (
                      <button
                        key={isFit ? item.key : item.id}
                        type="button"
                        className={`qt-matrix-pill ${isSelected ? "qt-selected" : ""}`}
                        onClick={() => setSelected(isFit ? item.key : `${item.id}:none`)}>
                        <b>{truckName}</b>
                        <span style={{ color: "var(--db-fg-dim)" }}>{dh} mi DH</span>
                        {isFit && item.allInPerMile ? <span>{perMile(item.allInPerMile)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="qt-matrix-body-scroll">
                  {rows.length === 0 && unpricedFleet.length > 0 ? (
                    <table className="qt-matrix-table" aria-label="Fleet trucks by deadhead">
                      <thead>
                        <tr>
                          <th aria-label="Pick" style={{ width: 28 }} />
                          <th>Truck & Driver (Base)</th>
                          <th style={{ textAlign: "right" }}>Deadhead to Pickup</th>
                          <th>Status</th>
                          <th style={{ textAlign: "right" }}>Floor</th>
                          <th style={{ textAlign: "right" }}>Left Over</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unpricedFleet.map((t, idx) => {
                          const on = (selected ? selected.startsWith(t.id) : (initial?.vehicleId === t.id || idx === 0));
                          return (
                            <tr
                              key={t.id}
                              className={on ? "qt-selected" : undefined}
                              onClick={() => {
                                setSelected(`${t.id}:none`);
                              }}>
                              <td>
                                <input
                                  type="radio"
                                  name="qt-pick"
                                  checked={on}
                                  onChange={() => {
                                    setSelected(`${t.id}:none`);
                                  }}
                                  aria-label={`Select ${t.name}`}
                                />
                              </td>
                              <td>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                                  <b>{t.name}</b>
                                  <span style={{ fontSize: 10, color: "var(--db-fg-dim)", fontFamily: "monospace" }}>[{idx + 1}]</span>
                                  {t.homeBaseAddress ? (
                                    <span className="sub" style={{ fontSize: 11, color: "var(--db-accent-fg)", fontWeight: 500 }}>
                                      Base: {t.homeBaseAddress}
                                    </span>
                                  ) : null}
                                </div>
                                <span className="sub">
                                  {t.drivers.length > 0 ? t.drivers.map((d) => d.name).join(", ") : "No driver set"}
                                </span>
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <input
                                  className="qt-mini"
                                  inputMode="decimal"
                                  aria-label={`Empty miles for ${t.name}`}
                                  placeholder={values.emptyToPickup || "—"}
                                  value={values.emptyByTruck[t.id] ?? ""}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    if (e.target.value.trim() === "") manual.current.delete(`empty:${t.id}`);
                                    else manual.current.add(`empty:${t.id}`);
                                    set({ emptyByTruck: { ...values.emptyByTruck, [t.id]: e.target.value } });
                                  }}
                                />
                                {values.emptyHomeByTruck[t.id] ? (
                                  <span className="sub" style={{ fontSize: 10 }}>+{values.emptyHomeByTruck[t.id]} home</span>
                                ) : null}
                              </td>
                              <td>
                                <span className="tl-tag">{t.hasCostProfile ? "Ready to price" : "No cost profile"}</span>
                              </td>
                              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--db-fg-dim)" }}>
                                —
                              </td>
                              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--db-fg-dim)" }}>
                                —
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : rows.length === 0 ? (
                    <p className="tl-note" style={{ padding: 14 }}>
                      {pricing ? "Finding the best truck…" : priced?.ok && priced.fit.skipped.length > 0 ? "No truck has a cost profile to price against." : "Type the offer and loaded miles to evaluate your fleet."}
                    </p>
                  ) : (
                    <table className="qt-matrix-table" aria-label="Which truck and driver">
                      <thead>
                        <tr>
                          <th aria-label="Pick" style={{ width: 28 }} />
                          <th>Truck & Driver (Base)</th>
                          <th style={{ textAlign: "right" }}>Deadhead to Pickup</th>
                          <th>Verdict</th>
                          <th style={{ textAlign: "right" }}>$/mi</th>
                          <th style={{ textAlign: "right" }}>Left Over</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((r, idx) => {
                          const said = verdictOf(r, benchmark, Boolean(cautions.marketRate));
                          const truckRows = rows.filter((x) => x.truckId === r.truckId);
                          const driverIdx = truckRows.findIndex((x) => x.key === r.key);
                          const driverSuffix = truckRows.length > 1 ? ` (driver ${driverIdx + 1} of ${truckRows.length})` : "";
                          const on = row?.key === r.key;
                          const truckInfo = fleet.find((f) => f.id === r.truckId);
                          // A note beside the verdict, never an input to it: the server's own hours check says "short", this words how far.
                          const deficit = hosDeficit({ level: r.hos.caution.level, availableHours: r.hos.availableHours, tripHours: r.detail.metrics.tripHours });
                          return (
                            <tr
                              key={r.key}
                              className={`${on ? "qt-selected" : ""}${r.blocked ? " qt-blocked" : ""}`.trim()}
                              onClick={() => setSelected(r.key)}>
                              <td>
                                <input
                                  type="radio"
                                  name="qt-pick"
                                  checked={on}
                                  onChange={() => setSelected(r.key)}
                                  aria-label={`Select ${r.truckName}`}
                                />
                              </td>
                              <td>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                                  <b>{r.truckName}</b>
                                  <span style={{ fontSize: 10, color: "var(--db-fg-dim)", fontFamily: "monospace" }}>[{idx + 1}]</span>
                                  {truckInfo?.homeBaseAddress ? (
                                    <span className="sub" style={{ fontSize: 11, color: "var(--db-accent-fg)", fontWeight: 500 }}>
                                      Base: {truckInfo.homeBaseAddress}
                                    </span>
                                  ) : null}
                                </div>
                                <span className="sub">{r.driverName ? `${r.driverName}${driverSuffix} · ${shortLabour(r)}` : "No driver set"}</span>
                                {r.hos.availableHours != null ? (
                                  <div className="qt-hos-line">
                                    <span className="sub" style={{ fontSize: 11, color: "var(--db-fg-mid)" }}>
                                      Hours left: {r.hos.availableHours}h{r.hos.syncedAt ? ` (${ago(r.hos.syncedAt)})` : ""}
                                    </span>
                                    {deficit ? (
                                      <span className="tl-chip warn" title={hosDeficitTitle(deficit)}>
                                        {hosDeficitLabel(deficit)}
                                      </span>
                                    ) : null}
                                  </div>
                                ) : null}
                                {r.blocked ? <span className="sub neg">{r.blocked}</span> : null}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <input
                                  className="qt-mini"
                                  inputMode="decimal"
                                  aria-label={`Empty miles for ${r.truckName}`}
                                  placeholder={values.emptyToPickup || "—"}
                                  value={values.emptyByTruck[r.truckId] ?? ""}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    if (e.target.value.trim() === "") manual.current.delete(`empty:${r.truckId}`);
                                    else manual.current.add(`empty:${r.truckId}`);
                                    set({ emptyByTruck: { ...values.emptyByTruck, [r.truckId]: e.target.value } });
                                  }}
                                />
                                {values.emptyHomeByTruck[r.truckId] ? (
                                  <span className="sub" style={{ fontSize: 10 }}>+{values.emptyHomeByTruck[r.truckId]} home</span>
                                ) : null}
                              </td>
                              <td>
                                <VerdictTag state={said.state} word={said.word} />
                              </td>
                              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                <div style={{ fontWeight: 700 }}>{perMile(r.allInPerMile)}</div>
                                <div className="sub" style={{ fontSize: 10, color: "var(--db-fg-dim)" }}>floor {perMile(r.floorPerMile)}</div>
                              </td>
                              <td
                                style={{
                                  textAlign: "right",
                                  fontVariantNumeric: "tabular-nums",
                                  fontWeight: 600,
                                  color: r.leftOver != null && r.leftOver < 0 ? "var(--db-neg)" : "var(--db-pos)"
                                }}>
                                {r.leftOver == null ? "—" : `${r.leftOver < 0 ? "−" : ""}${usd(Math.abs(r.leftOver), 0)}`}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>

            {/* 2. Selected Truck Live Verdict Card */}
            <aside id="qt-verdict" className="qt-side qt-eval-card" data-readonly={locked ? "true" : undefined} aria-label="The verdict" aria-live="polite" data-tone={verdict?.tone ?? "none"}>
              <h2 className="rc-eyebrow">
                {row ? `Priced for ${row.truckName}${row.driverName ? ` · ${row.driverName}` : ""}` : "The verdict"}
              </h2>

              {row && verdict ? (
                <>
                  <VerdictPanel
                    row={row}
                    verdict={verdict}
                    values={values}
                    lane={lane}
                    milesFrom={manual.current.has("loadedMiles") ? "typed" : measure.state === "ok" || values.loadedHours.trim() !== "" ? "measured" : "typed"}
                    fuelFrom={usedFuel != null ? "typed" : row.detail.fuelPerMile == null ? "none" : "own"}
                  />

                  {/* Counter-Offer Negotiation Assistant */}
                  <CounterOfferAssistant
                    currentOffer={currentOfferNum}
                    row={row}
                    onApply={handleApplyCounter}
                    onStep={handleStepOffer}
                  />
                </>
              ) : (
                <p className="tl-note">
                  {priceFailed ? "Not priced." : priced && !priced.ok ? "Type the offer and loaded miles to price it." : pricing ? "Pricing…" : "Type the offer and loaded miles to price it."}
                </p>
              )}

              {priceFailed ? (
                <div className="qt-retry" role="alert">
                  <p className="tl-note warn">{UNREACHABLE}</p>
                  <button type="button" className="tl-btn sm" onClick={() => setPriceAgain((n) => n + 1)}>
                    Try again
                  </button>
                </div>
              ) : null}

              {priced?.ok && priced.fit.trailersAvailable != null ? (
                <p className="tl-sub" style={{ marginTop: 4 }}>
                  {priced.fit.trailersAvailable.toLocaleString("en-US")} {priced.fit.trailersAvailable === 1 ? "trailer is" : "trailers are"} free{values.trailer ? ` of kind (${values.trailer.replace(/_/g, " ")})` : ""}.
                </p>
              ) : null}

              {message ? (
                <p className="tl-note warn" role="alert">
                  {message}
                </p>
              ) : null}

              {/* Action Buttons */}
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
                    {quoteId ? "Update quote" : "Save as quote"}
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
            </aside>

            {/* 3. Lane History & Customer Track Record */}
            {priced?.ok && (priced.context.lane || priced.context.broker) ? (
              <div className="qt-context" style={{ marginTop: 0 }}>
                {priced.context.lane ? (
                  <section className="tl-card">
                    <h3 style={{ fontSize: "var(--db-text-sm)", margin: "0 0 6px" }}>{`Last time on ${priced.context.lane.from} to ${priced.context.lane.to}`}</h3>
                    <p className="tl-note" style={{ marginBottom: 6, fontSize: 11 }}>
                      {priced.context.lane.count} finished {priced.context.lane.count === 1 ? "load" : "loads"}
                      {priced.context.lane.averagePerMile != null ? `, averaging ${perMile(priced.context.lane.averagePerMile)}` : ""}.
                    </p>
                    <table className="tl-table" aria-label="Lane history" style={{ fontSize: 11 }}>
                      <tbody>
                        {priced.context.lane.recent.slice(0, 3).map((l) => (
                          <tr key={l.id}>
                            <td>
                              <Link href={`/loads/${l.id}`}>{l.loadNumber ?? "Load"}</Link>
                            </td>
                            <td>{shortDate(l.on)}</td>
                            <td className="num">{usd(l.gross, 0)}</td>
                            <td className="num">{perMile(l.perMile)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                ) : null}
                {priced.context.broker ? (
                  <section className="tl-card">
                    <h3 style={{ fontSize: "var(--db-text-sm)", margin: "0 0 6px" }}>{priced.context.broker.name}</h3>
                    <dl className="tl-kv" style={{ fontSize: 11 }}>
                      <dt>Loads</dt>
                      <dd>{priced.context.broker.loads} ({priced.context.broker.finished} fin)</dd>
                      <dt>Avg RPM</dt>
                      <dd>{perMile(priced.context.broker.averagePerMile)}</dd>
                      <dt>Days to pay</dt>
                      <dd>{priced.context.broker.averageDaysToPay == null ? "None" : `${priced.context.broker.averageDaysToPay.toFixed(1)}d`}</dd>
                    </dl>
                  </section>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
      </div>

      {/* ── Ask Reason Modal ───────────────────────────────────────────────────── */}
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

      {/* ── Pass Reason Modal ──────────────────────────────────────────────────── */}
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

      {/* ── Quick-Paste Load Parser Modal ────────────────────────────────────── */}
      <Modal
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        eyebrow="Quick Quote"
        title="Paste Load Snippet">
        <div className="qt-paste-modal">
          <p className="tl-note">
            Paste text from an email, DAT, or customer message. We&apos;ll automatically extract the origin, destination, offer, weight, trailer, and MC.
          </p>
          <textarea
            className="qt-paste-textarea"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="e.g. Dallas, TX to Atlanta, GA. 42k lbs dry van paying $1,850 all-in. MC# 123456 PO: PO-9988"
            autoFocus
          />
          {pasteText.trim() ? (
            <dl className="qt-paste-preview">
              <div>
                <dt>Origin</dt>
                <dd>{parseBrokerSnippet(pasteText).origin || "—"}</dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>{parseBrokerSnippet(pasteText).destination || "—"}</dd>
              </div>
              <div>
                <dt>Offer / Rate</dt>
                <dd>{parseBrokerSnippet(pasteText).offer ? `$${parseBrokerSnippet(pasteText).offer}` : "—"}</dd>
              </div>
              <div>
                <dt>Weight</dt>
                <dd>{parseBrokerSnippet(pasteText).weightLbs ? `${parseBrokerSnippet(pasteText).weightLbs} lbs` : "—"}</dd>
              </div>
              <div>
                <dt>Trailer</dt>
                <dd>{parseBrokerSnippet(pasteText).trailer?.replace(/_/g, " ") || "—"}</dd>
              </div>
              <div>
                <dt>Customer MC</dt>
                <dd>{parseBrokerSnippet(pasteText).brokerMc || "—"}</dd>
              </div>
            </dl>
          ) : null}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--db-border)" }}>
            <span style={{ fontSize: 11, color: "var(--db-fg-dim)", display: "block", marginBottom: 6 }}>
              Or read a rate confirmation PDF:
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className="tl-btn sm"
                disabled={readingRateCon}
                onClick={() => {
                  setPasteOpen(false);
                  rateConInputRef.current?.click();
                }}>
                Upload Rate-Con PDF
              </button>
              <button
                type="button"
                className="tl-btn ghost sm"
                disabled={readingRateCon}
                onClick={() => {
                  setPasteOpen(false);
                  void handleSampleRateCon("RC-AFB-482913_dallas-to-houston_cargo-van.pdf");
                }}>
                Sample: Acme ($800)
              </button>
              <button
                type="button"
                className="tl-btn ghost sm"
                disabled={readingRateCon}
                onClick={() => {
                  setPasteOpen(false);
                  void handleSampleRateCon("RC-RDL-77315_fort-worth-waco-austin_box-truck.pdf");
                }}>
                Sample: Redline ($640, 3 stops)
              </button>
            </div>
          </div>
          <div className="dlg-actions">
            <button type="button" className="tl-btn" onClick={() => setPasteOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="tl-btn primary"
              disabled={!pasteText.trim()}
              onClick={handleApplyPaste}>
              Apply to Form
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Keyboard Shortcuts Guide Modal ─────────────────────────────────────── */}
      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        eyebrow="Quoting Terminal"
        title="Keyboard Shortcuts">
        <div style={{ display: "grid", gap: 12, minWidth: 380 }}>
          <table className="tl-table" style={{ fontSize: 13 }}>
            <tbody>
              <tr>
                <td><kbd style={{ padding: "2px 6px", background: "var(--db-bg-input)", border: "1px solid var(--db-border)", borderRadius: 4 }}>Ctrl + Enter</kbd></td>
                <td><b>Book load</b> on selected truck</td>
              </tr>
              <tr>
                <td><kbd style={{ padding: "2px 6px", background: "var(--db-bg-input)", border: "1px solid var(--db-border)", borderRadius: 4 }}>Ctrl + S</kbd></td>
                <td><b>Save quote</b> to saved list</td>
              </tr>
              <tr>
                <td><kbd style={{ padding: "2px 6px", background: "var(--db-bg-input)", border: "1px solid var(--db-border)", borderRadius: 4 }}>Alt + P</kbd></td>
                <td><b>Pass / Reject</b> on this quote</td>
              </tr>
              <tr>
                <td><kbd style={{ padding: "2px 6px", background: "var(--db-bg-input)", border: "1px solid var(--db-border)", borderRadius: 4 }}>Shift + P</kbd></td>
                <td>Open <b>Quick-Paste parser</b></td>
              </tr>
              <tr>
                <td><kbd style={{ padding: "2px 6px", background: "var(--db-bg-input)", border: "1px solid var(--db-border)", borderRadius: 4 }}>1 – 9</kbd></td>
                <td>Select truck row 1 through 9</td>
              </tr>
              <tr>
                <td><kbd style={{ padding: "2px 6px", background: "var(--db-bg-input)", border: "1px solid var(--db-border)", borderRadius: 4 }}>Enter</kbd></td>
                <td><b>Next field</b> in Pickup, Delivery, Offer and Loaded miles, then the Book button</td>
              </tr>
              <tr>
                <td><kbd style={{ padding: "2px 6px", background: "var(--db-bg-input)", border: "1px solid var(--db-border)", borderRadius: 4 }}>?</kbd></td>
                <td>Toggle this shortcuts guide</td>
              </tr>
            </tbody>
          </table>
          <div className="dlg-actions">
            <button type="button" className="tl-btn primary" onClick={() => setShortcutsOpen(false)}>
              Got it
            </button>
          </div>
        </div>
      </Modal>

      {/* Copy Brief, when the browser would not copy it: the text is selected here, ready to copy by hand. */}
      <Modal
        open={briefFallback != null}
        onClose={() => setBriefFallback(null)}
        eyebrow="Ready to paste"
        title={briefFallback?.label ?? "Brief"}
        footer={
          <button type="button" className="tl-btn primary" onClick={() => setBriefFallback(null)}>
            Done
          </button>
        }>
        <p className="tl-note" style={{ marginBottom: 8 }}>This browser would not copy it for you. The text is selected: copy it, then paste it where it goes.</p>
        <textarea data-autofocus readOnly value={briefFallback?.text ?? ""} rows={10} aria-label={briefFallback?.label ?? "Brief"} style={{ width: "100%" }} onFocus={(e) => e.currentTarget.select()} />
      </Modal>
    </div>
  );
}

/** Short labour note for matrix row. */
function shortLabour(r: FitRow): string {
  const m = /: (.*?), plus/.exec(r.labourNote);
  return m ? `pay ${m[1]}` : r.labourNote;
}

/** The line under the Offer field: "$2.92/mi loaded", the typed offer over the typed loaded miles (gross, before any fee). Nothing until both are typed. */
function grossNote(offer: string, loadedMiles: string): string | undefined {
  const g = grossPerLoadedMile(offer, loadedMiles);
  return g == null ? undefined : `${perMile(g)} loaded`;
}

/** Form money input with inline unit. `note` is a live figure read off the form, a quiet line below the field (not announced: the verdict aside is the one live region). */
function Money({ label, unit, value, error, caution, onChange, hint, note, onEnter }: { label: string; unit: string; value: string; error?: string; caution?: string; onChange: (v: string) => void; hint?: string; note?: string; onEnter?: () => void }) {
  const id = `qt-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="th-field">
      <label htmlFor={id}>{label}</label>
      <div className="th-input">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={
            onEnter
              ? (e) => {
                  // Enter moves on to the next field of the quick way through a quote; every other key, and Tab, does what it always did.
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    onEnter();
                  }
                }
              : undefined
          }
        />
        <span>{unit}</span>
      </div>
      {error ? (
        <span className="th-err" role="alert">
          {error}
        </span>
      ) : caution ? (
        <span className="th-hint" style={{ color: "var(--db-warn)" }}>{caution}</span>
      ) : hint ? (
        <span className="th-hint">{hint}</span>
      ) : null}
      {note ? <span className="th-hint">{note}</span> : null}
    </div>
  );
}

/** What the audited math said about one way of running the load, as a verdict. */
function verdictOf(row: FitRow, benchmark: Benchmark, marketSuspect?: boolean): VerdictRead {
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
    hourlyTarget: d.hourlyTarget,
    marketSuspect
  });
}

/**
 * Counter-Offer Negotiation Assistant:
 * Calculates required rates for Break-even, +10% target, +15% target, and +$50/+$100/+$250 steppers.
 */
function CounterOfferAssistant({
  currentOffer,
  row,
  onApply,
  onStep
}: {
  currentOffer: number;
  row: FitRow;
  onApply: (val: number) => void;
  onStep: (delta: number) => void;
}) {
  const totalTripMiles = row.totalMiles || 1;
  const floorRate = row.floorPerMile || 0;
  const profitPerMile = row.detail?.metrics?.profitPerMile ?? row.marginPerMile ?? 0;

  let breakEvenOffer: number | null = null;
  if (profitPerMile < 0) {
    const neededExtra = Math.ceil(Math.abs(profitPerMile) * totalTripMiles);
    breakEvenOffer = Math.round((currentOffer + neededExtra) / 10) * 10;
  } else if (floorRate > 0) {
    breakEvenOffer = Math.round((floorRate * totalTripMiles) / 10) * 10;
  }

  const baseForTargets = breakEvenOffer != null ? Math.max(breakEvenOffer, currentOffer) : currentOffer;
  const target10Offer = Math.round((baseForTargets + totalTripMiles * 0.25) / 10) * 10;
  const target15Offer = Math.round((baseForTargets + totalTripMiles * 0.50) / 10) * 10;

  return (
    <div className="qt-negotiate">
      <div className="qt-negotiate-head">
        <span>Counter-Offer Targets</span>
        <span className="tl-sub" style={{ fontSize: 11 }}>Click to test rate</span>
      </div>
      <div className="qt-targets">
        {breakEvenOffer != null ? (
          <button
            type="button"
            className="qt-target-chip"
            title="Break-even offer to clear $0 margin"
            onClick={() => onApply(breakEvenOffer!)}>
            <span>Floor:</span>
            <b>${breakEvenOffer.toLocaleString()}</b>
            {breakEvenOffer > currentOffer ? (
              <span className="qt-diff">+${(breakEvenOffer - currentOffer).toLocaleString()}</span>
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          className="qt-target-chip"
          title="Target offer for healthy +$0.25/mi profit margin"
          onClick={() => onApply(target10Offer)}>
          <span>Target (+10%):</span>
          <b>${target10Offer.toLocaleString()}</b>
          {target10Offer > currentOffer ? (
            <span className="qt-diff">+${(target10Offer - currentOffer).toLocaleString()}</span>
          ) : null}
        </button>
        <button
          type="button"
          className="qt-target-chip"
          title="Target offer for high-yield +$0.50/mi profit margin"
          onClick={() => onApply(target15Offer)}>
          <span>Target (+15%):</span>
          <b>${target15Offer.toLocaleString()}</b>
          {target15Offer > currentOffer ? (
            <span className="qt-diff">+${(target15Offer - currentOffer).toLocaleString()}</span>
          ) : null}
        </button>
      </div>
      <div className="qt-steppers">
        <span style={{ fontSize: 11, color: "var(--db-fg-dim)", marginRight: 4 }}>Bump:</span>
        <button type="button" className="qt-step-btn" onClick={() => onStep(50)}>+$50</button>
        <button type="button" className="qt-step-btn" onClick={() => onStep(100)}>+$100</button>
        <button type="button" className="qt-step-btn" onClick={() => onStep(250)}>+$250</button>
        <button type="button" className="qt-step-btn" onClick={() => onStep(500)}>+$500</button>
        {currentOffer > 0 ? (
          <button type="button" className="qt-step-btn" onClick={() => onStep(-50)} title="Reduce offer by $50">-$50</button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The Verdict card. Its skeleton does not change from load to load or from surface to surface:
 * the word, why, the figure, where the load lands, the working, what it rests on.
 */
function VerdictPanel({ row, verdict, values, lane, milesFrom, fuelFrom }: { row: FitRow; verdict: VerdictRead; values: QuoteValues; lane: LaneBenchmark | null; milesFrom: "measured" | "typed"; fuelFrom: "own" | "typed" | "none" }) {
  const d = row.detail;
  const home = values.loadBack ? "a load covers the way home" : Number(values.emptyHome) > 0 ? `${miles(Number(values.emptyHome))} empty home` : "no empty miles home";
  const notes: string[] = [];
  if (d.routeMinimum && !d.routeMinimum.meets) notes.push(`The route minimum of ${usd(d.routeMinimum.expected, 0)} is not met.`);
  if (d.rejectReason && verdict.state !== "reject") notes.push(d.rejectReason);
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
        {d.marketVariancePct != null && !verdict.marketSuspect ? (
          <div>
            <dt>{lane ? "Against your lane" : "Against market"}</dt>
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
          {d.routeMinimum.meets ? `Meets route minimum of ${usd(d.routeMinimum.expected, 0)}.` : `Under route minimum of ${usd(d.routeMinimum.expected, 0)}: pay is ${usd(d.fees.net, 0)} after fees.`}
        </p>
      ) : null}
      <details className="qt-figures">
        <summary>See all the figures</summary>
        <dl className="rc-facts">
          <div>
            <dt>Load rate after fees (loaded miles)</dt>
            <dd>{perMile(d.metrics.loadRpm)}</dd>
          </div>
          <div>
            <dt>Pickup rate (to pickup too)</dt>
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
      {lane ? <p className="vc-trust">{`Compared with ${ground[2]!.label.toLowerCase()}: ${perMile(lane.perMile)} on loaded miles${verdict.ruler?.market ? `, ${perMile(verdict.ruler.market.value)} over every mile` : ""}.`}</p> : null}
      <p className="vc-trust">{trust.length > 0 ? `Taken on trust: ${trust.map((g) => g.label.toLowerCase()).join(", ")}.` : "Every figure here was measured or is on record."}</p>
    </div>
  );
}
