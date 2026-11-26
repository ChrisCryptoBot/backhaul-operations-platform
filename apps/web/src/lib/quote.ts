import { LOAD_LIMITS } from "./load-limits";
import type { AcceptGate, MarketBand } from "@/truelane/lib/domain/marketVerdict";
import type { Benchmark } from "./verdict";
import { fuelSurchargeDollars, type FuelSurchargeUnit } from "@/truelane/lib/fuelSurcharge";
import { isUnusualValue } from "@/truelane/lib/formatNumbers";
import { parseCentralLocal } from "./zoned";
import { activeTz } from "./tz";

/** A stop's point when both halves are real coordinates, else none. */
const pointOf = (s: { lat?: unknown; lng?: unknown }): { lat: number | null; lng: number | null } => {
  const lat = typeof s.lat === "number" && Number.isFinite(s.lat) && Math.abs(s.lat) <= 90 ? s.lat : null;
  const lng = typeof s.lng === "number" && Number.isFinite(s.lng) && Math.abs(s.lng) <= 180 ? s.lng : null;
  return lat != null && lng != null ? { lat, lng } : { lat: null, lng: null };
};

/** The clock a stop's typed time is read on: its own when known, else the carrier's. */
const clockOf = (s: { zone?: string | null }) => (s.zone && s.zone.trim() !== "" ? s.zone : activeTz());
import type { LoadSpecs } from "./load-fit";
import { isOtherTrailer, OTHER_TRAILER_MAX, OTHER_TRAILER_PREFIX, TRAILER_TYPES } from "@/truelane/constants/trailerData";
import { PACKING_GROUPS, REEFER_MODES, type PackingGroup, type ReeferMode } from "./load-edit";

/**
 * A quote is the phone's Calculate screen as a dispatcher uses it: an offer on a load that is not booked yet, priced against a truck's cost
 * floor and the market. This file is the form's side: the values as typed, the checks (strict to save or book, lenient to price as you type),
 * and the phone's own wording for the verdict band and for the question asked before a load that needs one is accepted. Pure: the browser and
 * the server both run it.
 */
export type QuoteStopRole = "pickup" | "delivery";
export type QuoteStop = {
  role: QuoteStopRole;
  address: string;
  /** "2026-10-30T08:00" on the clock at the stop (`zone`), or blank: the dock's time, as the broker and the rate confirmation say it. */
  appointment: string;
  /**
   * The clock at this stop (an IANA zone), worked out on the server from where the stop is (server/geo/stop-zone.ts). The server works it out again on every save and booking and never takes
   * the browser's; the form keeps it only to show the right clock and to check the order of the stops. Left out, a time is read on the carrier's clock.
   */
  zone?: string | null;
  /** Where the road measure found the stop, so the server can tell the clock in a state that spans two zones. Cleared when the address changes. */
  lat?: number | null;
  lng?: number | null;
  appointmentEnd?: string;
  facility?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
  refs?: string;
};

export type QuoteValues = {
  stops: QuoteStop[];
  broker: string;
  /** The broker's paperwork, kept on the load when it is booked. All optional. */
  brokerMc: string;
  loadNumber: string;
  rateConNumber?: string;
  proNumber?: string;
  bolNumber?: string;
  poNumber: string;
  brokerPhone: string;
  brokerEmail: string;
  trailer: string;
  commodity?: string;
  pieceCount?: string;
  palletCount?: string;
  /** What the load is, so a truck that cannot carry it is not offered. All optional; blank checks nothing. */
  weightLbs: string;
  lengthFt: string;
  widthFt: string;
  heightIn: string;
  reeferSetTempF?: string;
  reeferMinF?: string;
  reeferMaxF?: string;
  reeferMode?: string;
  hazmatClass: string;
  hazmatUnNumber?: string;
  hazmatPackingGroup?: string;
  hazmatEmergencyPhone?: string;
  requiresLiftgate: boolean;
  requiresRamp: boolean;
  requiresPalletJack: boolean;
  notes?: string;
  paymentTerms?: string;
  detentionFreeMinutes?: string;
  detentionHourlyRate?: string;
  rateConPath?: string;
  offer: string;
  fsc: string;
  fscUnit: FuelSurchargeUnit;
  /** What the load would pay at market, as a total for the load (typed by hand, as on the phone). */
  marketRate: string;
  loadedMiles: string;
  /** Empty miles from the truck to the pickup. The same for every truck unless one is typed for it in `emptyByTruck`. */
  emptyToPickup: string;
  /** Empty miles home after the last delivery. */
  emptyHome: string;
  /** "I have a load back": the way home is covered, so it counts as no empty miles. */
  loadBack: boolean;
  payTermsDays: string;
  /** Blank uses the truck's own factoring fee. */
  factoringPct: string;
  emptyByTruck: Record<string, string>;
  /** Empty miles home after the last delivery, for one truck (measured from its base). A typed `emptyHome` replaces all of them. */
  emptyHomeByTruck: Record<string, string>;
  /** Drive hours for the loaded miles as measured on the road. Blank: the verdict assumes 50 mph over every mile. Cleared when the loaded miles are typed by hand. */
  loadedHours: string;
  /** A fuel price to price this check with, in place of each truck's own. Blank uses theirs. Kept with the quote and written into the booking record, so what a load was judged on is never lost. */
  fuelPrice: string;
  /** Where the fuel price came from: typed by hand, or filled with the regional price. Blank when there is none. */
  fuelSource: "" | "typed" | "regional";
  /** What the verdict also counts, as the phone does (all optional, blank is none): time at the docks, a trailer or towing cost, a permit or escort, and an insurance rider. */
  dockWaitMinutes: string;
  /** Dollars a mile added to the truck's cost while it tows or hauls this trailer. */
  towingPerMile: string;
  /** Dollars for the load, spread over its miles. */
  permitEscort: string;
  /** Dollars for the load, taken out of the pay. */
  insuranceRider: string;
  /** How wide "at the market" is drawn: "5" tight, blank the usual 10, "15" wide. The rule that asks for a reason stays at 10%. */
  marketBand: "" | "5" | "15";
  /** The driver picked for the quote, kept with it so a reopened quote comes back on the same driver. */
  driverId: string;
  /** The figures somebody typed by hand ("loadedMiles", "emptyToPickup", "emptyHome", "empty:<truck>"): a later measure leaves these alone. Kept with the quote. */
  manual: string[];
};

export const BLANK_QUOTE: QuoteValues = {
  stops: [
    { role: "pickup", address: "", appointment: "" },
    { role: "delivery", address: "", appointment: "" }
  ],
  broker: "",
  brokerMc: "",
  loadNumber: "",
  rateConNumber: "",
  proNumber: "",
  bolNumber: "",
  poNumber: "",
  brokerPhone: "",
  brokerEmail: "",
  trailer: "",
  commodity: "",
  pieceCount: "",
  palletCount: "",
  weightLbs: "",
  lengthFt: "",
  widthFt: "",
  heightIn: "",
  reeferSetTempF: "",
  reeferMinF: "",
  reeferMaxF: "",
  reeferMode: "",
  hazmatClass: "",
  hazmatUnNumber: "",
  hazmatPackingGroup: "",
  hazmatEmergencyPhone: "",
  requiresLiftgate: false,
  requiresRamp: false,
  requiresPalletJack: false,
  notes: "",
  paymentTerms: "",
  detentionFreeMinutes: "",
  detentionHourlyRate: "",
  rateConPath: "",
  offer: "",
  fsc: "",
  fscUnit: "percent",
  marketRate: "",
  loadedMiles: "",
  emptyToPickup: "",
  emptyHome: "",
  loadBack: false,
  payTermsDays: "",
  factoringPct: "",
  emptyByTruck: {},
  emptyHomeByTruck: {},
  loadedHours: "",
  fuelPrice: "",
  fuelSource: "",
  dockWaitMinutes: "",
  towingPerMile: "",
  permitEscort: "",
  insuranceRider: "",
  marketBand: "",
  driverId: "",
  manual: []
};

export type QuoteInput = {
  stops: Array<{
    role: QuoteStopRole;
    address: string;
    /** Where the measure found it (kept on the stop so a reopened quote reads the same clock), or null. */
    lat: number | null;
    lng: number | null;
    appointment: number | null;
    appointmentEnd: number | null;
    facility: string | null;
    contactName: string | null;
    contactPhone: string | null;
    notes: string | null;
    refs: string[];
  }>;
  broker: string | null;
  brokerMc: string | null;
  loadNumber: string | null;
  rateConNumber: string | null;
  proNumber: string | null;
  bolNumber: string | null;
  poNumber: string | null;
  brokerPhone: string | null;
  brokerEmail: string | null;
  trailer: string | null;
  commodity: string | null;
  pieceCount: number | null;
  palletCount: number | null;
  reeferSetTempF: number | null;
  reeferMinF: number | null;
  reeferMaxF: number | null;
  reeferMode: ReeferMode | null;
  hazmatUnNumber: string | null;
  hazmatPackingGroup: PackingGroup | null;
  hazmatEmergencyPhone: string | null;
  notes: string | null;
  paymentTerms: string | null;
  detentionFreeMinutes: number | null;
  detentionHourlyRate: number | null;
  rateConPath: string | null;
  specs: LoadSpecs;
  offer: number;
  fsc: number;
  fscUnit: FuelSurchargeUnit;
  marketTotal: number | null;
  loadedMiles: number;
  emptyToPickup: number;
  emptyHome: number;
  loadBack: boolean;
  payTermsDays: number | null;
  factoringFraction: number | null;
  emptyByTruck: Record<string, number>;
  emptyHomeByTruck: Record<string, number>;
  loadedHours: number | null;
  /** Dollars a gallon to use for every diesel truck in this check, or null for each truck's own. */
  fuelPrice: number | null;
  fuelSource: "typed" | "regional" | null;
  dockWaitMinutes: number;
  towingPerMile: number;
  permitEscort: number;
  insuranceRider: number;
  /** Half-width of the "at market" band, 0.05, 0.10 or 0.15. */
  marketBandFraction: number;
  driverId: string | null;
  manual: string[];
};

export type QuoteErrors = Record<string, string>;
/** The most stops a quote holds: the road measure takes no more. */
export const MAX_QUOTE_STOPS = 10;

/** The nine US DOT hazard classes, as a list to pick from (a free-text field invited "None", which then read as hazmat). */
export const HAZMAT_CLASSES = [
  { value: "1", label: "Class 1: Explosives" },
  { value: "2", label: "Class 2: Gases" },
  { value: "3", label: "Class 3: Flammable liquids" },
  { value: "4", label: "Class 4: Flammable solids" },
  { value: "5", label: "Class 5: Oxidizers and peroxides" },
  { value: "6", label: "Class 6: Toxic and infectious" },
  { value: "7", label: "Class 7: Radioactive" },
  { value: "8", label: "Class 8: Corrosives" },
  { value: "9", label: "Class 9: Miscellaneous" }
] as const;
export type QuoteCheck = { ok: true; input: QuoteInput; warnings: string[] } | { ok: false; errors: QuoteErrors };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (s: string): number | null => {
  if (s === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** The number in a field, or null when it is blank or not a number. For the live price, which never stops for a stray field. */
/** The fuel price typed for this check: a believable price a gallon (the cost profile allows $0.50 to $25), else none. */
const fuelOverride = (s: string): number | null => {
  const n = num(str(s));
  return n != null && n >= 0.5 && n <= 25 ? n : null;
};

/** More decimal places than `places` in a typed number ("1500.555" has three): money is kept to the cent, so a figure with more is a slip. */
export const tooManyDecimals = (raw: string, places: number): boolean => {
  const m = /\.(\d+)$/.exec(raw.replace(/,/g, "").trim());
  return m != null && m[1]!.length > places;
};

const positive = (s: string): number | null => {
  const n = num(str(s));
  return n != null && n > 0 ? n : null;
};

/**
 * The gross rate per loaded mile, for the line under the Offer field: the typed offer over the typed loaded miles, before any fee.
 * Null until both are positive, and under a mile of loaded run, where the figure is noise. It is a quoting yardstick read straight off
 * the two fields, so it moves the instant either is typed; it is not the verdict's "Load rate", which is net of the carrier's cut,
 * factoring and the rider.
 */
export function grossPerLoadedMile(offer: string, loadedMiles: string): number | null {
  const o = positive(offer);
  const m = positive(loadedMiles);
  if (o == null || m == null || m < 1) return null;
  return o / m;
}

/**
 * The route run the other way, for the swap button: the addresses reverse, while each stop keeps its own role and its own time. A
 * two-stop quote simply swaps pickup and delivery; with stops between, the whole run reverses. The times stay where they are on purpose:
 * carrying them along would put the delivery before the pickup, and the form refuses that.
 */
export function reverseStops(stops: QuoteStop[]): QuoteStop[] {
  const flipped = [...stops].reverse();
  return stops.map((s, i) => {
    const f = flipped[i];
    return {
      ...s,
      address: f?.address ?? "",
      ...(f?.appointmentEnd !== undefined ? { appointmentEnd: f.appointmentEnd } : s.appointmentEnd !== undefined ? { appointmentEnd: "" } : {}),
      ...(f?.facility !== undefined ? { facility: f.facility } : s.facility !== undefined ? { facility: "" } : {}),
      ...(f?.contactName !== undefined ? { contactName: f.contactName } : s.contactName !== undefined ? { contactName: "" } : {}),
      ...(f?.contactPhone !== undefined ? { contactPhone: f.contactPhone } : s.contactPhone !== undefined ? { contactPhone: "" } : {}),
      ...(f?.notes !== undefined ? { notes: f.notes } : s.notes !== undefined ? { notes: "" } : {}),
      ...(f?.refs !== undefined ? { refs: f.refs } : s.refs !== undefined ? { refs: "" } : {})
    };
  });
}

/** The empty-mile figures that depend on which way the route runs: to the pickup, home after the delivery, and one truck's own. */
const isDeadheadKey = (k: string) => k === "emptyToPickup" || k === "emptyHome" || k.startsWith("empty:");

/**
 * The quote with its route swapped. Empty miles are measured from each truck's base to the pickup and from the delivery back to it, so
 * both change with the swap: they are blanked, and no longer count as typed, so the map measures them again. Everything else stays,
 * the loaded miles included (the run is the same road; a measured figure refreshes on its own and a typed one is the person's).
 */
export function swapRoute(values: QuoteValues): QuoteValues {
  return {
    ...values,
    stops: reverseStops(values.stops),
    emptyToPickup: "",
    emptyHome: "",
    emptyByTruck: {},
    emptyHomeByTruck: {},
    manual: values.manual.filter((k) => !isDeadheadKey(k))
  };
}

/** Whether anything has been typed: the form against what it started from, leaving out the fuel price figure itself (the form fills that in by itself). */
export function isQuoteDirty(values: QuoteValues, baseline: QuoteValues): boolean {
  return JSON.stringify({ ...values, fuelPrice: "" }) !== JSON.stringify({ ...baseline, fuelPrice: "" });
}

/** Everything the price needs and nothing it does not: an offer and loaded miles. Null until both are typed. */
export function readQuote(values: QuoteValues): QuoteInput | null {
  const offer = positive(values.offer);
  const loadedMiles = positive(values.loadedMiles);
  if (offer == null || loadedMiles == null) return null;
  const nonNeg = (s: string) => {
    const n = num(str(s));
    return n != null && n >= 0 ? n : 0;
  };
  const byTruck: Record<string, number> = {};
  for (const [k, v] of Object.entries(values.emptyByTruck ?? {})) {
    const n = num(str(v));
    if (n != null && n >= 0) byTruck[k] = n;
  }
  const homeByTruck: Record<string, number> = {};
  for (const [k, v] of Object.entries(values.emptyHomeByTruck ?? {})) {
    const n = num(str(v));
    if (n != null && n >= 0) homeByTruck[k] = n;
  }
  const fsc = nonNeg(values.fsc);
  const market = positive(values.marketRate);
  const factoring = num(str(values.factoringPct));
  const splitStopRefs = (raw?: string): string[] =>
    str(raw)
      .split(/[,;\n]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 10);
  const reeferModeRaw = str(values.reeferMode ?? "").toLowerCase();
  const reeferMode = (REEFER_MODES as readonly string[]).includes(reeferModeRaw) ? (reeferModeRaw as ReeferMode) : null;
  const pgRaw = str(values.hazmatPackingGroup ?? "").toUpperCase();
  const hazmatPackingGroup = (PACKING_GROUPS as readonly string[]).includes(pgRaw) ? (pgRaw as PackingGroup) : null;
  const wholeNonNeg = (s: string): number | null => {
    const n = num(str(s));
    return n != null && Number.isInteger(n) && n >= 0 ? n : null;
  };
  const decNonNeg = (s: string): number | null => {
    const n = num(str(s));
    return n != null && n >= 0 ? n : null;
  };
  return {
    stops: values.stops.map((s) => ({
      role: s.role,
      address: str(s.address),
      ...pointOf(s),
      appointment: s.appointment ? parseCentralLocal(s.appointment, clockOf(s)) : null,
      appointmentEnd: s.appointmentEnd ? parseCentralLocal(s.appointmentEnd, clockOf(s)) : null,
      facility: str(s.facility) || null,
      contactName: str(s.contactName) || null,
      contactPhone: str(s.contactPhone) || null,
      notes: str(s.notes) || null,
      refs: splitStopRefs(s.refs)
    })),
    broker: str(values.broker) || null,
    brokerMc: str(values.brokerMc).replace(/^mc[\s-]*/i, "") || null,
    loadNumber: str(values.loadNumber) || null,
    rateConNumber: str(values.rateConNumber ?? "") || null,
    proNumber: str(values.proNumber ?? "") || null,
    bolNumber: str(values.bolNumber ?? "") || null,
    poNumber: str(values.poNumber) || null,
    brokerPhone: str(values.brokerPhone) || null,
    brokerEmail: str(values.brokerEmail) || null,
    trailer: str(values.trailer) || null,
    commodity: str(values.commodity ?? "") || null,
    pieceCount: positive(values.pieceCount ?? ""),
    palletCount: positive(values.palletCount ?? ""),
    reeferSetTempF: num(str(values.reeferSetTempF ?? "")),
    reeferMinF: num(str(values.reeferMinF ?? "")),
    reeferMaxF: num(str(values.reeferMaxF ?? "")),
    reeferMode,
    hazmatUnNumber: str(values.hazmatUnNumber ?? "") || null,
    hazmatPackingGroup,
    hazmatEmergencyPhone: str(values.hazmatEmergencyPhone ?? "") || null,
    notes: str(values.notes ?? "").slice(0, 1000) || null,
    paymentTerms: str(values.paymentTerms ?? "").slice(0, 120) || null,
    detentionFreeMinutes: wholeNonNeg(values.detentionFreeMinutes ?? ""),
    detentionHourlyRate: decNonNeg(values.detentionHourlyRate ?? ""),
    rateConPath: str(values.rateConPath ?? "") || null,
    specs: {
      weightLbs: positive(values.weightLbs ?? ""),
      lengthFt: positive(values.lengthFt ?? ""),
      widthFt: positive(values.widthFt ?? ""),
      heightIn: positive(values.heightIn ?? ""),
      hazmatClass: str(values.hazmatClass ?? "") || null,
      requiresLiftgate: values.requiresLiftgate === true,
      requiresRamp: values.requiresRamp === true,
      requiresPalletJack: values.requiresPalletJack === true
    },
    offer,
    fsc,
    fscUnit: values.fscUnit === "per_mile" ? "per_mile" : "percent",
    marketTotal: market,
    loadedMiles,
    emptyToPickup: nonNeg(values.emptyToPickup),
    emptyHome: nonNeg(values.emptyHome),
    loadBack: values.loadBack === true,
    payTermsDays: num(str(values.payTermsDays)),
    factoringFraction: factoring != null && factoring >= 0 && factoring <= 100 ? factoring / 100 : null,
    emptyByTruck: byTruck,
    emptyHomeByTruck: homeByTruck,
    loadedHours: positive(values.loadedHours ?? ""),
    fuelPrice: fuelOverride(values.fuelPrice ?? ""),
    fuelSource: fuelOverride(values.fuelPrice ?? "") == null ? null : values.fuelSource === "regional" ? "regional" : "typed",
    dockWaitMinutes: nonNeg(values.dockWaitMinutes ?? ""),
    towingPerMile: nonNeg(values.towingPerMile ?? ""),
    permitEscort: nonNeg(values.permitEscort ?? ""),
    insuranceRider: nonNeg(values.insuranceRider ?? ""),
    marketBandFraction: values.marketBand === "5" ? 0.05 : values.marketBand === "15" ? 0.15 : 0.1,
    driverId: str(values.driverId ?? "") || null,
    manual: Array.isArray(values.manual) ? values.manual.filter((m): m is string => typeof m === "string").slice(0, 60) : []
  };
}

/** The check to save a quote or book it: every field that was typed must be right, and the route must be a route. */
export function validateQuote(values: QuoteValues): QuoteCheck {
  const errors: QuoteErrors = {};
  const stops = values.stops;
  if (stops.length < 2) errors.stops = "A load needs a pickup and a delivery.";
  else if (stops.length > MAX_QUOTE_STOPS) errors.stops = `At most ${MAX_QUOTE_STOPS} stops.`;
  else {
    if (stops[0]!.role !== "pickup") errors.stops = "The first stop is the pickup.";
    else if (stops[stops.length - 1]!.role !== "delivery") errors.stops = "The last stop is a delivery.";
  }
  stops.forEach((s, i) => {
    if (str(s.address).length < 2) errors[`stop${i}`] = "Where is this stop? A city and state is enough.";
    else if (str(s.address).length > 200) errors[`stop${i}`] = "At most 200 characters.";
    const openMs = s.appointment ? parseCentralLocal(s.appointment, clockOf(s)) : null;
    if (s.appointment && openMs == null) errors[`stop${i}Time`] = "A real date and time.";
    const closeMs = s.appointmentEnd ? parseCentralLocal(s.appointmentEnd, clockOf(s)) : null;
    if (s.appointmentEnd && closeMs == null) errors[`stop${i}TimeEnd`] = "A real date and time.";
    else if (openMs != null && closeMs != null && closeMs < openMs) errors[`stop${i}TimeEnd`] = "The window cannot close before it opens.";
    if (str(s.facility).length > 80) errors[`stop${i}Facility`] = "At most 80 characters.";
    if (str(s.contactName).length > 60) errors[`stop${i}ContactName`] = "At most 60 characters.";
    const sp = str(s.contactPhone);
    if (sp !== "" && (sp.replace(/\D/g, "").length < 7 || sp.replace(/\D/g, "").length > 15 || /[^\d\s()+.\-x]/i.test(sp))) errors[`stop${i}ContactPhone`] = "A phone number, for example 555-0142.";
    if (str(s.notes).length > 300) errors[`stop${i}Notes`] = "At most 300 characters.";
    const refsList = str(s.refs)
      .split(/[,;\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (refsList.length > 10) errors[`stop${i}Refs`] = "Ten reference numbers at most.";
    else if (refsList.some((r) => r.length > 40)) errors[`stop${i}Refs`] = "A reference number is too long.";
  });
  // Stops in order: a stop cannot be due before the one ahead of it.
  let earlier: number | null = null;
  stops.forEach((s, i) => {
    const t = s.appointment ? parseCentralLocal(s.appointment, clockOf(s)) : null;
    if (t == null) return;
    if (earlier != null && t < earlier && !errors[`stop${i}Time`]) errors[`stop${i}Time`] = "This is before the stop ahead of it. Check the date and time.";
    else earlier = t;
  });
  if (str(values.broker).length > 120) errors.broker = "At most 120 characters.";
  const trailerRaw = str(values.trailer ?? "");
  if (trailerRaw !== "" && !TRAILER_TYPES.some((t) => t.value === trailerRaw) && !isOtherTrailer(trailerRaw) && trailerRaw !== "hopper") errors.trailer = "Pick a trailer from the list.";
  if (isOtherTrailer(trailerRaw) && trailerRaw.length > OTHER_TRAILER_PREFIX.length + OTHER_TRAILER_MAX) errors.trailer = "That equipment name is too long.";
  const mc = str(values.brokerMc).replace(/^mc[\s-]*/i, "");
  if (mc !== "" && !/^\d{3,8}$/.test(mc)) errors.brokerMc = "Digits only, for example 123456.";
  if (str(values.loadNumber).length > 40) errors.loadNumber = "At most 40 characters.";
  if (str(values.rateConNumber ?? "").length > 40) errors.rateConNumber = "At most 40 characters.";
  if (str(values.proNumber ?? "").length > 40) errors.proNumber = "At most 40 characters.";
  if (str(values.bolNumber ?? "").length > 60) errors.bolNumber = "At most 60 characters.";
  if (str(values.poNumber).length > 40) errors.poNumber = "At most 40 characters.";
  if (str(values.commodity ?? "").length > 120) errors.commodity = "At most 120 characters.";
  const phone = str(values.brokerPhone);
  if (phone !== "" && (phone.replace(/\D/g, "").length < 7 || phone.replace(/\D/g, "").length > 15 || /[^\d\s()+.\-x]/i.test(phone))) errors.brokerPhone = "A phone number, for example 555-0142.";
  const email = str(values.brokerEmail);
  if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.brokerEmail = "An email address, for example name@example.com.";
  for (const [key, label, max, whole] of [
    ["pieceCount", "Pieces", 100_000, true],
    ["palletCount", "Pallets", 10_000, true],
    ["weightLbs", "Weight in pounds", LOAD_LIMITS.weightLbs, true],
    ["lengthFt", "Length in feet", LOAD_LIMITS.lengthFt, false],
    ["widthFt", "Width in feet", LOAD_LIMITS.widthFt, false],
    ["heightIn", "Height in inches", LOAD_LIMITS.heightIn, false]
  ] as const) {
    const raw = str(values[key] ?? "");
    if (raw === "") continue;
    const n = num(raw);
    if (n == null || !(n > 0) || n > max || (whole && !Number.isInteger(n))) errors[key] = `${label}: ${whole ? "a whole number" : "a number"} above 0 and up to ${max.toLocaleString("en-US")}.`;
  }
  const tempCheck = (key: "reeferSetTempF" | "reeferMinF" | "reeferMaxF", label: string): number | null => {
    const raw = str(values[key] ?? "");
    if (raw === "") return null;
    const n = num(raw);
    if (n == null || n < -60 || n > 150) {
      errors[key] = `${label}: a number from -60 to 150.`;
      return null;
    }
    return n;
  };
  tempCheck("reeferSetTempF", "Set temperature");
  const rMin = tempCheck("reeferMinF", "Minimum temperature");
  const rMax = tempCheck("reeferMaxF", "Maximum temperature");
  if (rMin != null && rMax != null && rMin > rMax && !errors.reeferMaxF) {
    errors.reeferMaxF = "Maximum temperature cannot be below minimum temperature.";
  }
  const rMode = str(values.reeferMode ?? "").toLowerCase();
  if (rMode !== "" && !(REEFER_MODES as readonly string[]).includes(rMode)) errors.reeferMode = "Pick continuous or cycle.";
  if (str(values.hazmatClass ?? "").length > 20) errors.hazmatClass = "At most 20 characters.";
  if (str(values.hazmatUnNumber ?? "").length > 20) errors.hazmatUnNumber = "At most 20 characters.";
  const pgCheck = str(values.hazmatPackingGroup ?? "").toUpperCase();
  if (pgCheck !== "" && !(PACKING_GROUPS as readonly string[]).includes(pgCheck)) errors.hazmatPackingGroup = "Pick I, II, or III.";
  const hPhone = str(values.hazmatEmergencyPhone ?? "");
  if (hPhone !== "" && (hPhone.replace(/\D/g, "").length < 7 || hPhone.replace(/\D/g, "").length > 15 || /[^\d\s()+.\-x]/i.test(hPhone))) {
    errors.hazmatEmergencyPhone = "A phone number, for example 800-424-9300.";
  }
  if (str(values.notes ?? "").length > 1000) errors.notes = "At most 1,000 characters.";
  if (str(values.paymentTerms ?? "").length > 120) errors.paymentTerms = "At most 120 characters.";
  const detFree = str(values.detentionFreeMinutes ?? "");
  if (detFree !== "") {
    const n = num(detFree);
    if (n == null || !Number.isInteger(n) || n < 0 || n > 1440) errors.detentionFreeMinutes = "Whole minutes, 0 to 1,440.";
  }
  const detRate = str(values.detentionHourlyRate ?? "");
  if (detRate !== "") {
    const n = num(detRate);
    if (n == null || n < 0 || n > 1000) errors.detentionHourlyRate = "Hourly rate from $0 to $1,000.";
  }
  const offer = num(str(values.offer));
  if (offer == null || !(offer > 0)) errors.offer = "Type what the load pays.";
  else if (offer > 100000) errors.offer = "That is a lot for one load. Check it.";
  const miles = num(str(values.loadedMiles));
  if (miles == null || !(miles > 0)) errors.loadedMiles = "Type the loaded miles.";
  else if (miles > 5000) errors.loadedMiles = "Under 5,000 miles.";
  for (const [key, label] of [["emptyToPickup", "Empty miles to the pickup"], ["emptyHome", "Empty miles home"]] as const) {
    const raw = str(values[key]);
    if (raw !== "") {
      const n = num(raw);
      if (n == null || n < 0 || n > 5000) errors[key] = `${label}: a number from 0 to 5,000.`;
    }
  }
  for (const [truck, raw] of Object.entries(values.emptyByTruck ?? {})) {
    const r = str(raw);
    if (r !== "") {
      const n = num(r);
      if (n == null || n < 0 || n > 5000) errors[`empty:${truck}`] = "A number from 0 to 5,000.";
    }
  }
  for (const [truck, raw] of Object.entries(values.emptyHomeByTruck ?? {})) {
    const r = str(raw);
    if (r !== "") {
      const n = num(r);
      if (n == null || n < 0 || n > 5000) errors[`emptyHome:${truck}`] = "A number from 0 to 5,000.";
    }
  }
  const fuelRaw = str(values.fuelPrice ?? "");
  if (fuelRaw !== "" && fuelOverride(fuelRaw) == null) errors.fuelPrice = "A price a gallon, $0.50 to $25.";
  const hoursRaw = str(values.loadedHours ?? "");
  if (hoursRaw !== "") {
    const n = num(hoursRaw);
    if (n == null || !(n > 0) || n > 200) errors.loadedHours = "Drive hours, above 0 and under 200.";
  }
  for (const [key, label, max] of [["dockWaitMinutes", "Dock wait in minutes", 1440], ["towingPerMile", "Towing cost a mile", 10], ["permitEscort", "Permit or escort cost", 50000], ["insuranceRider", "Insurance rider", 50000]] as const) {
    const raw = str(values[key] ?? "");
    if (raw === "") continue;
    const n = num(raw);
    if (n == null || n < 0 || n > max) errors[key] = `${label}: a number from 0 to ${max.toLocaleString("en-US")}.`;
  }
  const fscRaw = str(values.fsc);
  if (fscRaw !== "") {
    const n = num(fscRaw);
    if (n == null || n < 0) errors.fsc = "A number, 0 or more.";
    else if (values.fscUnit === "percent" && n > 100) errors.fsc = "A percent from 0 to 100.";
  }
  const marketRaw = str(values.marketRate);
  if (marketRaw !== "") {
    const n = num(marketRaw);
    if (n == null || !(n > 0)) errors.marketRate = "A total for the load, more than 0.";
  }
  const terms = str(values.payTermsDays);
  if (terms !== "") {
    const n = num(terms);
    if (n == null || !Number.isInteger(n) || n < 0 || n > 120) errors.payTermsDays = "Whole days, 0 to 120.";
  }
  const fact = str(values.factoringPct);
  if (fact !== "") {
    const n = num(fact);
    if (n == null || n < 0 || n > 100) errors.factoringPct = "A percent from 0 to 100.";
  }
  // Money to the cent (a rate a mile to a tenth of a cent), as an invoice keeps it: the price is never worked out on a figure the load cannot hold.
  for (const [key, places] of [["offer", 2], ["marketRate", 2], ["permitEscort", 2], ["insuranceRider", 2], ["detentionHourlyRate", 2], ["towingPerMile", 3]] as const) {
    const raw = str(values[key] ?? "");
    if (raw !== "" && !errors[key] && tooManyDecimals(raw, places)) errors[key] = places === 2 ? "Dollars and cents, at most two decimal places." : "At most three decimal places.";
  }
  if (!errors.fsc && str(values.fsc) !== "" && tooManyDecimals(str(values.fsc), values.fscUnit === "per_mile" ? 3 : 2)) errors.fsc = values.fscUnit === "per_mile" ? "At most three decimal places." : "A percent with at most two decimal places.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const input = readQuote(values)!;
  const warnings = quoteWarnings(input);
  const first = input.stops[0]?.appointment;
  if (first != null && first < Date.now() - 24 * 3_600_000) warnings.push("The pickup time is in the past. Check the date, or the year.");
  return { ok: true, input, warnings };
}

/**
 * What the phone asks "did you mean" about on this screen: a market rate that works out under $0.50 or over $15 a mile (the usual slip is
 * a per-mile rate typed where the total goes), and a per-mile surcharge over $3.
 */
export function quoteWarnings(input: QuoteInput): string[] {
  const c = quoteCautions(input);
  return [c.marketRate, c.fsc, c.factoringPct].filter((s): s is string => s != null);
}

/** A "did you mean" note, keyed by the field it is about. */
export type QuoteCautions = { marketRate?: string; fsc?: string; factoringPct?: string };

/**
 * The same checks as quoteWarnings, keyed by field, so the desk can show each one under its own field as the phone does (a caution card under the market
 * rate on Calculate, `marketTotalEntryWarning`). Showing them changes no figure: the price is still worked out from what was typed.
 */
export function quoteCautions(input: QuoteInput): QuoteCautions {
  const out: QuoteCautions = {};
  const miles = input.emptyToPickup + input.loadedMiles + (input.loadBack ? 0 : input.emptyHome);
  if (input.marketTotal != null && miles > 0) {
    const perMile = input.marketTotal / miles;
    if (perMile < 0.5 || perMile > 15) out.marketRate = (`A market rate of $${input.marketTotal.toLocaleString("en-US")} over ${Math.round(miles).toLocaleString("en-US")} miles is $${perMile.toFixed(2)} a mile. The market rate is the total for the load, not a rate per mile.`);
  }
  if (input.fscUnit === "per_mile" && isUnusualValue("fscPerMile", input.fsc)) out.fsc = (`A fuel surcharge of $${input.fsc} a loaded mile is above the usual range (under $3).`);
  // The phone's softer nudges: a surcharge that is half the offer, or over $2 a loaded mile, is more often a slip than a rate.
  else if (input.fscUnit === "percent" && input.fsc >= 50) out.fsc = (`A fuel surcharge of ${input.fsc}% of the offer is very high. Did you mean ${input.fsc / 10}% or ${input.fsc / 100}%?`);
  else if (input.fscUnit === "per_mile" && input.fsc > 2) out.fsc = (`A fuel surcharge of $${input.fsc} a loaded mile looks high. Check it.`);
  if (input.factoringFraction != null && input.factoringFraction >= 0.5) out.factoringPct = (`A factoring fee of ${(input.factoringFraction * 100).toFixed(0)}% is very high. Did you mean ${(input.factoringFraction * 10).toFixed(1)}%?`);
  return out;
}

/**
 * The offer that covers the floor, from the audited pay needed (`payNeeded`: the offer plus the surcharge that follows it, worked out by the vendored rules with the carrier's cut, factoring
 * and the rider). The surcharge is taken back out the way it was typed (a percent rides on the offer, a rate a mile does not), and the answer is rounded up to the dollar so it is never a cent
 * short. Null when the load already clears (the rules only work the figure out when there is a gap) or nothing is known.
 */
export function floorOffer(i: { payNeeded: number | null | undefined; gross: number; marginPerMile: number | null; fsc: number; fscUnit: FuelSurchargeUnit; loadedMiles: number }): number | null {
  if (i.payNeeded == null || !Number.isFinite(i.payNeeded) || i.marginPerMile == null || i.marginPerMile >= 0 || i.payNeeded <= i.gross) return null;
  const fsc = Number.isFinite(i.fsc) && i.fsc > 0 ? i.fsc : 0;
  const offer = i.fscUnit === "per_mile" ? i.payNeeded - fsc * i.loadedMiles : i.payNeeded / (1 + fsc / 100);
  return offer > 0 ? Math.ceil(offer - 1e-9) : null;
}

/** The surcharge in dollars, whichever way it was typed: a percent of the offer or dollars per loaded mile, as the phone adds it. */
export function surchargeDollars(input: Pick<QuoteInput, "offer" | "loadedMiles" | "fsc" | "fscUnit">): number {
  return fuelSurchargeDollars({ offerDollars: input.offer, loadedMiles: input.loadedMiles, amount: input.fsc, unit: input.fscUnit });
}

/** The verdict band's wording on the phone's Calculate header, and the tone it takes here. */
export const BAND_LABEL: Record<MarketBand, { label: string; tone: "ok" | "warn" | "bad" | "info" }> = {
  below_floor: { label: "Below your cost", tone: "bad" },
  needs_fuel: { label: "Add mpg and fuel price", tone: "warn" },
  strong_caution: { label: "Strong caution", tone: "bad" },
  negotiate: { label: "Negotiate up", tone: "warn" },
  at_market: { label: "At market", tone: "info" },
  above_market: { label: "Above market", tone: "ok" },
  no_benchmark: { label: "Add a market rate", tone: "warn" }
};

/** The question asked before a load is accepted that needs a reason, as the phone words it. */
export function gateTitle(gate: AcceptGate, benchmark: Benchmark = "market"): string {
  if (gate === "needs_fuel") return "Book without knowing the fuel cost?";
  if (gate === "no_market") return "Book without knowing the market rate?";
  if (gate === "under_market") return benchmark === "lane" ? "Book this well under what the lane pays you?" : "Book this below-market load?";
  return "Why book a load that does not cover its costs?";
}

/** Why a quote was passed on, in the order the dialog offers them. */
export const PASS_REASONS = ["Rate too low", "Lost to another carrier", "Customer pulled it", "Cannot cover it", "Other"] as const;

/** The phone's override reasons, in its order. */
export const OVERRIDE_REASONS = ["Relationship", "Positioning for return load", "Cash flow", "Other"] as const;
export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

/**
 * What booking needs that pricing does not: a time at both ends. The desk cannot yet edit a stop, and a load with no times cannot be planned
 * or chased, so it is asked for here rather than booked without.
 */
export function missingTimes(stops: Array<{ appointment: string | number | null }>): QuoteErrors {
  const out: QuoteErrors = {};
  const last = stops.length - 1;
  const blank = (v: string | number | null | undefined) => v == null || v === "";
  if (stops.length > 0 && blank(stops[0]!.appointment)) out.stop0Time = "Add the pickup time to book it, so it can be planned.";
  if (stops.length > 1 && blank(stops[last]!.appointment)) out[`stop${last}Time`] = "Add the delivery time to book it.";
  return out;
}

/** Whether there is a load to decide on: an offer and miles. Over an empty form there is nothing to book. */
export const hasSomethingToBook = (input: QuoteInput | null) => input != null && input.offer > 0 && input.loadedMiles > 0;
