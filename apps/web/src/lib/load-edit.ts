import { OTHER_TRAILER_MAX, OTHER_TRAILER_PREFIX, TRAILER_TYPES, isOtherTrailer } from "@/truelane/constants/trailerData";
import { parseCentralLocal, toCentralLocal } from "./zoned";

/**
 * Changing what a booked load says: who it is for, its numbers, what it weighs and needs, and each stop's place, times, references and
 * contact. Checked here and again on the server, so a bad value is named next to its field, never fixed silently. Pure.
 */
export type EditStopValues = {
  id: string;
  role: "pickup" | "delivery";
  address: string;
  facility: string;
  /** "2026-10-30T08:00" on the Dallas clock, or blank. */
  earliest: string;
  latest: string;
  /** Reference numbers, separated by commas. */
  refs: string;
  contactName: string;
  contactPhone: string;
  notes: string;
};

/** The money and the truck: what the load pays, how far it runs, and which truck has it. Optional so a caller that only fixes details can leave it out. */
export type DealValues = {
  /** The truck's id, or blank for none. */
  vehicleId: string;
  /** The agreed rate in dollars. */
  rate: string;
  /** Fuel surcharge in dollars on the load, or blank. */
  fuelSurcharge: string;
  loadedMiles: string;
  emptyToPickup: string;
  emptyHome: string;
};

export type LoadEditValues = {
  brokerName: string;
  brokerMc: string;
  brokerPhone: string;
  brokerEmail: string;
  loadNumber: string;
  poNumber: string;
  trailer: string;
  weightLbs: string;
  lengthFt: string;
  widthFt: string;
  heightIn: string;
  hazmat: string;
  liftgate: boolean;
  ramp: boolean;
  palletJack: boolean;
  payTermsDays: string;
  notes: string;
  stops: EditStopValues[];
  deal?: DealValues;
};

export type DealInput = { vehicleId: string | null; rate: number; fuelSurcharge: number | null; loadedMiles: number; emptyToPickup: number; emptyHome: number };

export type LoadEditInput = {
  brokerName: string | null;
  brokerMc: string | null;
  brokerPhone: string | null;
  brokerEmail: string | null;
  loadNumber: string | null;
  poNumber: string | null;
  trailer: string | null;
  weightLbs: number | null;
  lengthFt: number | null;
  widthFt: number | null;
  heightIn: number | null;
  hazmat: string | null;
  liftgate: boolean;
  ramp: boolean;
  palletJack: boolean;
  payTermsDays: number | null;
  notes: string | null;
  stops: Array<{ id: string; address: string; facility: string | null; earliest: Date | null; latest: Date | null; refs: string[]; contactName: string | null; contactPhone: string | null; notes: string | null }>;
  deal: DealInput | null;
};

export type LoadEditCheck = { ok: true; value: LoadEditInput } | { ok: false; errors: Record<string, string> };

const t = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const orNull = (s: string) => (s === "" ? null : s);
const phoneOk = (p: string) => {
  const digits = p.replace(/\D/g, "");
  return !(digits.length < 7 || digits.length > 15 || /[^\d\s()+.\-x]/i.test(p));
};

export const splitRefs = (s: string): string[] =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function validateLoadEdit(v: LoadEditValues): LoadEditCheck {
  const errors: Record<string, string> = {};
  const num = (key: string, raw: string, label: string, min: number, max: number, whole = false): number | null => {
    const s = t(raw).replace(/,/g, "");
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
      errors[key] = `${label}: ${whole ? "a whole number" : "a number"} from ${min} to ${max.toLocaleString("en-US")}.`;
      return null;
    }
    return n;
  };
  const len = (key: string, raw: string, label: string, max: number) => {
    if (t(raw).length > max) errors[key] = `${label} is too long (${max} characters at most).`;
  };

  len("brokerName", v.brokerName, "The customer's name", 80);
  const mc = t(v.brokerMc).replace(/^mc[\s-]*/i, "");
  if (mc !== "" && !/^\d{3,8}$/.test(mc)) errors.brokerMc = "Digits only, for example 123456.";
  if (t(v.brokerPhone) && !phoneOk(t(v.brokerPhone))) errors.brokerPhone = "A phone number, for example 555-0142.";
  if (t(v.brokerEmail) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t(v.brokerEmail))) errors.brokerEmail = "An email address, for example name@example.com.";
  len("loadNumber", v.loadNumber, "The load number", 40);
  len("poNumber", v.poNumber, "The PO number", 40);
  const trailer = t(v.trailer);
  // A listed trailer, equipment typed as "other:<text>" or the retired "hopper" a saved load can still carry (what the rate-confirmation reader produces) are all fine to save back.
  if (trailer !== "" && !TRAILER_TYPES.some((x) => x.value === trailer) && !isOtherTrailer(trailer) && trailer !== "hopper") errors.trailer = "Pick a trailer from the list.";
  if (isOtherTrailer(trailer) && trailer.length > OTHER_TRAILER_PREFIX.length + OTHER_TRAILER_MAX) errors.trailer = "That equipment name is too long.";
  const weightLbs = num("weightLbs", v.weightLbs, "Weight", 1, 80000, true);
  const lengthFt = num("lengthFt", v.lengthFt, "Length", 1, 100);
  const widthFt = num("widthFt", v.widthFt, "Width", 1, 20);
  const heightIn = num("heightIn", v.heightIn, "Height", 1, 200);
  len("hazmat", v.hazmat, "The hazmat class", 20);
  const payTermsDays = num("payTermsDays", v.payTermsDays, "Pay terms", 0, 120, true);
  len("notes", v.notes, "Notes", 1000);

  let deal: DealInput | null = null;
  if (v.deal) {
    const d = v.deal;
    // Zero is allowed so a load that was saved with no rate can still have its other details corrected; a blank is a slip.
    const rate = num("deal.rate", d.rate, "The rate", 0, 1_000_000);
    if (rate == null && !errors["deal.rate"]) errors["deal.rate"] = "Type the agreed rate.";
    const fuelSurcharge = num("deal.fuelSurcharge", d.fuelSurcharge, "The fuel surcharge", 0, 100_000);
    const loadedMiles = num("deal.loadedMiles", d.loadedMiles, "Loaded miles", 0, 5000);
    const emptyToPickup = num("deal.emptyToPickup", d.emptyToPickup, "Empty miles to the pickup", 0, 5000);
    const emptyHome = num("deal.emptyHome", d.emptyHome, "Empty miles home", 0, 5000);
    if (t(d.vehicleId) === "?") errors["deal.vehicleId"] = "Pick a truck from the list.";
    deal = { vehicleId: orNull(t(d.vehicleId)), rate: rate ?? 0, fuelSurcharge, loadedMiles: loadedMiles ?? 0, emptyToPickup: emptyToPickup ?? 0, emptyHome: emptyHome ?? 0 };
  }

  const stops = v.stops.map((s, i) => {
    const key = (f: string) => `stop${i}.${f}`;
    if (t(s.address).length < 2) errors[key("address")] = "Where is this stop? A city and state is enough.";
    len(key("facility"), s.facility, "The facility", 80);
    len(key("contactName"), s.contactName, "The contact", 60);
    if (t(s.contactPhone) && !phoneOk(t(s.contactPhone))) errors[key("contactPhone")] = "A phone number, for example 555-0142.";
    len(key("notes"), s.notes, "The stop's notes", 300);
    const refs = splitRefs(s.refs);
    if (refs.length > 10) errors[key("refs")] = "Ten reference numbers at most.";
    else if (refs.some((r) => r.length > 40)) errors[key("refs")] = "A reference number is too long.";
    const earliest = t(s.earliest) ? parseCentralLocal(t(s.earliest)) : null;
    const latest = t(s.latest) ? parseCentralLocal(t(s.latest)) : null;
    if (t(s.earliest) && earliest == null) errors[key("earliest")] = "A real date and time.";
    if (t(s.latest) && latest == null) errors[key("latest")] = "A real date and time.";
    if (latest != null && earliest == null && !errors[key("latest")]) errors[key("earliest")] = "Add when the window opens.";
    if (earliest != null && latest != null && latest < earliest) errors[key("latest")] = "The window cannot close before it opens.";
    return {
      id: s.id,
      address: t(s.address),
      facility: orNull(t(s.facility)),
      earliest: earliest == null ? null : new Date(earliest),
      latest: latest == null ? null : new Date(latest),
      refs,
      contactName: orNull(t(s.contactName)),
      contactPhone: orNull(t(s.contactPhone)),
      notes: orNull(t(s.notes))
    };
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      brokerName: orNull(t(v.brokerName)),
      brokerMc: orNull(mc),
      brokerPhone: orNull(t(v.brokerPhone)),
      brokerEmail: orNull(t(v.brokerEmail)),
      loadNumber: orNull(t(v.loadNumber)),
      poNumber: orNull(t(v.poNumber)),
      trailer: orNull(trailer),
      weightLbs,
      lengthFt,
      widthFt,
      heightIn,
      hazmat: orNull(t(v.hazmat)),
      liftgate: v.liftgate === true,
      ramp: v.ramp === true,
      palletJack: v.palletJack === true,
      payTermsDays,
      notes: orNull(t(v.notes)),
      stops,
      deal
    }
  };
}

type StoredLoad = {
  vehicleId?: string | null;
  quotedRevenue?: unknown;
  fuelSurcharge?: unknown;
  loadedMiles?: unknown;
  pickupDeadheadMiles?: unknown;
  returnDeadheadMiles?: unknown;
  brokerName: string | null;
  brokerMcNumber: string | null;
  brokerPhone: string | null;
  brokerEmail: string | null;
  loadNumber: string | null;
  poNumber: string | null;
  trailerType: string | null;
  weightLbs: number | null;
  lengthFt: unknown;
  widthFt: unknown;
  loadHeightIn: unknown;
  hazmatClass: string | null;
  requiresLiftgate: boolean | null;
  requiresRamp: boolean | null;
  requiresPalletJack: boolean | null;
  payTermsDays: number | null;
  notes: string | null;
  stops: Array<{ id: string; stopRole: string | null; stopType: string; addressString: string; facilityName: string | null; timeWindowEarliest: Date | null; timeWindowLatest: Date | null; referenceNumbers: unknown; contactName: string | null; contactPhone: string | null; stopNotes: string | null }>;
};

/** The form's values from a stored load, with times on the Dallas clock. */
export function toEditValues(load: StoredLoad): LoadEditValues {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const local = (d: Date | null) => (d ? toCentralLocal(d.getTime()) : "");
  /** A stored decimal as the figure to show: no trailing zeros, blank when there is none or it is zero. */
  const money = (v: unknown) => {
    if (v == null) return "";
    const n = Number(String(v));
    return Number.isFinite(n) && n !== 0 ? String(n) : "";
  };
  return {
    brokerName: s(load.brokerName),
    brokerMc: s(load.brokerMcNumber),
    brokerPhone: s(load.brokerPhone),
    brokerEmail: s(load.brokerEmail),
    loadNumber: s(load.loadNumber),
    poNumber: s(load.poNumber),
    trailer: s(load.trailerType),
    weightLbs: s(load.weightLbs),
    lengthFt: s(load.lengthFt),
    widthFt: s(load.widthFt),
    heightIn: s(load.loadHeightIn),
    hazmat: s(load.hazmatClass),
    liftgate: load.requiresLiftgate === true,
    ramp: load.requiresRamp === true,
    palletJack: load.requiresPalletJack === true,
    payTermsDays: s(load.payTermsDays),
    notes: s(load.notes),
    deal: {
      vehicleId: s(load.vehicleId),
      rate: load.quotedRevenue == null ? "" : String(Number(String(load.quotedRevenue))),
      fuelSurcharge: money(load.fuelSurcharge),
      loadedMiles: money(load.loadedMiles),
      emptyToPickup: money(load.pickupDeadheadMiles),
      emptyHome: money(load.returnDeadheadMiles)
    },
    stops: load.stops.map((x) => ({
      id: x.id,
      role: (x.stopRole ?? x.stopType) === "delivery" ? "delivery" : "pickup",
      address: x.addressString,
      facility: s(x.facilityName),
      earliest: local(x.timeWindowEarliest),
      latest: local(x.timeWindowLatest),
      refs: Array.isArray(x.referenceNumbers) ? (x.referenceNumbers as unknown[]).map(String).join(", ") : "",
      contactName: s(x.contactName),
      contactPhone: s(x.contactPhone),
      notes: s(x.stopNotes)
    }))
  };
}
