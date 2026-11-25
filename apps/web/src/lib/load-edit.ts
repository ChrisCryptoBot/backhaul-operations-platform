import { LOAD_LIMITS } from "./load-limits";
import { roleOfStop } from "./stop-role";
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
  /** "2026-10-30T08:00" on the clock at the stop (`zone`), or blank: the dock's time, as the rate confirmation prints it. */
  earliest: string;
  latest: string;
  /** The clock at this stop (an IANA zone), filled in from where the stop is. Left out, a time is read on the carrier's clock. */
  zone?: string | null;
  /** Reference numbers, separated by commas. */
  refs: string;
  contactName: string;
  contactPhone: string;
  notes: string;
  /** True once a driver has arrived at this stop; locks address, time, role, and sequence order. */
  visited?: boolean;
};

export const STOP_CHANGE_REASONS = [
  { key: "reconsignment", label: "Reconsignment" },
  { key: "appointment_change", label: "Appointment change" },
  { key: "stop_added", label: "Stop added" },
  { key: "stop_dropped", label: "Stop dropped" }
] as const;
export type StopChangeReason = (typeof STOP_CHANGE_REASONS)[number]["key"];
export const isStopChangeReason = (v: unknown): v is StopChangeReason =>
  typeof v === "string" && STOP_CHANGE_REASONS.some((r) => r.key === v);
export const STOP_CHANGE_FEE_LABEL: Record<StopChangeReason, string> = {
  reconsignment: "Reconsignment",
  appointment_change: "Appointment change",
  stop_added: "Stop added",
  stop_dropped: "Stop dropped"
};

export const REEFER_MODES = ["continuous", "cycle"] as const;
export type ReeferMode = (typeof REEFER_MODES)[number];
export const PACKING_GROUPS = ["I", "II", "III"] as const;
export type PackingGroup = (typeof PACKING_GROUPS)[number];

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
  rateConNumber?: string;
  proNumber?: string;
  poNumber: string;
  bolNumber?: string;
  trailer: string;
  commodity?: string;
  pieceCount?: string;
  palletCount?: string;
  weightLbs: string;
  lengthFt: string;
  widthFt: string;
  heightIn: string;
  reeferSetTempF?: string;
  reeferMinF?: string;
  reeferMaxF?: string;
  reeferMode?: string;
  hazmat: string;
  hazmatUnNumber?: string;
  hazmatPackingGroup?: string;
  hazmatEmergencyPhone?: string;
  liftgate: boolean;
  ramp: boolean;
  palletJack: boolean;
  payTermsDays: string;
  notes: string;
  stops: EditStopValues[];
  stopChangeReason?: string;
  stopChangeFee?: string;
  deal?: DealValues;
  /** When the load was last changed, as it was when the form opened: a save made on an older version is refused, so a stale form cannot overwrite what someone else changed. */
  version?: string;
};

export type DealInput = { vehicleId: string | null; rate: number; fuelSurcharge: number | null; loadedMiles: number; emptyToPickup: number; emptyHome: number };

export type LoadEditInput = {
  brokerName: string | null;
  brokerMc: string | null;
  brokerPhone: string | null;
  brokerEmail: string | null;
  loadNumber: string | null;
  rateConNumber: string | null;
  proNumber: string | null;
  poNumber: string | null;
  bolNumber: string | null;
  trailer: string | null;
  commodity: string | null;
  pieceCount: number | null;
  palletCount: number | null;
  weightLbs: number | null;
  lengthFt: number | null;
  widthFt: number | null;
  heightIn: number | null;
  reeferSetTempF: number | null;
  reeferMinF: number | null;
  reeferMaxF: number | null;
  reeferMode: ReeferMode | null;
  hazmat: string | null;
  hazmatUnNumber: string | null;
  hazmatPackingGroup: PackingGroup | null;
  hazmatEmergencyPhone: string | null;
  liftgate: boolean;
  ramp: boolean;
  palletJack: boolean;
  payTermsDays: number | null;
  notes: string | null;
  stopChangeReason: StopChangeReason | null;
  stopChangeFee: number | null;
  stops: Array<{ id: string; role: "pickup" | "delivery"; address: string; facility: string | null; earliest: Date | null; latest: Date | null; refs: string[]; contactName: string | null; contactPhone: string | null; notes: string | null }>;
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

export function validateLoadEdit(v: LoadEditValues, fallbackZone?: string): LoadEditCheck {
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
  len("rateConNumber", v.rateConNumber ?? "", "The rate con number", 40);
  len("proNumber", v.proNumber ?? "", "The PRO number", 40);
  len("poNumber", v.poNumber, "The PO number", 40);
  len("bolNumber", v.bolNumber ?? "", "The BOL number", 60);
  len("commodity", v.commodity ?? "", "Commodity", 120);
  const trailer = t(v.trailer);
  // A listed trailer, equipment typed as "other:<text>" or the retired "hopper" a saved load can still carry (what the rate-confirmation reader produces) are all fine to save back.
  if (trailer !== "" && !TRAILER_TYPES.some((x) => x.value === trailer) && !isOtherTrailer(trailer) && trailer !== "hopper") errors.trailer = "Pick a trailer from the list.";
  if (isOtherTrailer(trailer) && trailer.length > OTHER_TRAILER_PREFIX.length + OTHER_TRAILER_MAX) errors.trailer = "That equipment name is too long.";
  const pieceCount = num("pieceCount", v.pieceCount ?? "", "Pieces", 1, 100_000, true);
  const palletCount = num("palletCount", v.palletCount ?? "", "Pallets", 1, 10_000, true);
  const weightLbs = num("weightLbs", v.weightLbs, "Weight", 1, LOAD_LIMITS.weightLbs, true);
  const lengthFt = num("lengthFt", v.lengthFt, "Length", 1, LOAD_LIMITS.lengthFt);
  const widthFt = num("widthFt", v.widthFt, "Width", 1, LOAD_LIMITS.widthFt);
  const heightIn = num("heightIn", v.heightIn, "Height", 1, LOAD_LIMITS.heightIn);
  const reeferSetTempF = num("reeferSetTempF", v.reeferSetTempF ?? "", "Set temperature", -60, 150);
  const reeferMinF = num("reeferMinF", v.reeferMinF ?? "", "Minimum temperature", -60, 150);
  const reeferMaxF = num("reeferMaxF", v.reeferMaxF ?? "", "Maximum temperature", -60, 150);
  if (reeferMinF != null && reeferMaxF != null && reeferMinF > reeferMaxF && !errors.reeferMaxF) {
    errors.reeferMaxF = "Maximum temperature cannot be below minimum temperature.";
  }
  const reeferModeRaw = t(v.reeferMode ?? "").toLowerCase();
  if (reeferModeRaw !== "" && !(REEFER_MODES as readonly string[]).includes(reeferModeRaw)) errors.reeferMode = "Pick continuous or cycle.";
  len("hazmat", v.hazmat, "The hazmat class", 20);
  len("hazmatUnNumber", v.hazmatUnNumber ?? "", "UN number", 20);
  const pgRaw = t(v.hazmatPackingGroup ?? "").toUpperCase();
  if (pgRaw !== "" && !(PACKING_GROUPS as readonly string[]).includes(pgRaw)) errors.hazmatPackingGroup = "Pick I, II, or III.";
  const hazmatPhone = t(v.hazmatEmergencyPhone ?? "");
  if (hazmatPhone !== "" && !phoneOk(hazmatPhone)) errors.hazmatEmergencyPhone = "A phone number, for example 800-424-9300.";
  const payTermsDays = num("payTermsDays", v.payTermsDays, "Pay terms", 0, 120, true);
  len("notes", v.notes, "Notes", 1000);
  const stopReasonRaw = t(v.stopChangeReason ?? "");
  if (stopReasonRaw !== "" && !isStopChangeReason(stopReasonRaw)) errors.stopChangeReason = "Pick a stop change reason.";
  const stopFeeRaw = t(v.stopChangeFee ?? "").replace(/,/g, "");
  let stopChangeFee: number | null = null;
  if (stopFeeRaw !== "") {
    const fee = Number(stopFeeRaw);
    if (!/^\d+(\.\d{1,2})?$/.test(stopFeeRaw) || !Number.isFinite(fee) || fee < 0 || fee > 100_000) {
      errors.stopChangeFee = "Extra fee: dollars and cents from 0 to 100,000.";
    } else if (fee > 0) {
      stopChangeFee = fee;
    }
  }

  let deal: DealInput | null = null;
  if (v.deal) {
    const d = v.deal;
    // Zero is allowed so a load that was saved with no rate can still have its other details corrected; a blank is a slip.
    const rate = num("deal.rate", d.rate, "The rate", 0, 1_000_000);
    if (rate == null && !errors["deal.rate"]) errors["deal.rate"] = "Type the agreed rate.";
    const fuelSurcharge = num("deal.fuelSurcharge", d.fuelSurcharge, "The fuel surcharge", 0, 100_000);
    const loadedMiles = num("deal.loadedMiles", d.loadedMiles, "Loaded miles", 0, LOAD_LIMITS.miles);
    const emptyToPickup = num("deal.emptyToPickup", d.emptyToPickup, "Empty miles to the pickup", 0, LOAD_LIMITS.miles);
    const emptyHome = num("deal.emptyHome", d.emptyHome, "Empty miles home", 0, LOAD_LIMITS.miles);
    if (t(d.vehicleId) === "?") errors["deal.vehicleId"] = "Pick a truck from the list.";
    deal = { vehicleId: orNull(t(d.vehicleId)), rate: rate ?? 0, fuelSurcharge, loadedMiles: loadedMiles ?? 0, emptyToPickup: emptyToPickup ?? 0, emptyHome: emptyHome ?? 0 };
  }

  let maxPrevEarliest: number | null = null;
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
    const zone = s.zone ?? fallbackZone;
    const earliest = t(s.earliest) ? parseCentralLocal(t(s.earliest), zone) : null;
    const latest = t(s.latest) ? parseCentralLocal(t(s.latest), zone) : null;
    if (t(s.earliest) && earliest == null) errors[key("earliest")] = "A real date and time.";
    if (t(s.latest) && latest == null) errors[key("latest")] = "A real date and time.";
    if (latest != null && earliest == null && !errors[key("latest")]) errors[key("earliest")] = "Add when the window opens.";
    if (earliest != null && latest != null && latest < earliest) errors[key("latest")] = "The window cannot close before it opens.";
    if (earliest != null && maxPrevEarliest != null && earliest < maxPrevEarliest && !errors[key("earliest")]) {
      errors[key("earliest")] = "This stop cannot open before an earlier stop.";
    }
    if (earliest != null && (maxPrevEarliest == null || earliest > maxPrevEarliest)) maxPrevEarliest = earliest;
    return {
      id: s.id,
      role: (s.role === "pickup" ? "pickup" : "delivery") as "pickup" | "delivery",
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
      rateConNumber: orNull(t(v.rateConNumber ?? "")),
      proNumber: orNull(t(v.proNumber ?? "")),
      poNumber: orNull(t(v.poNumber)),
      bolNumber: orNull(t(v.bolNumber ?? "")),
      trailer: orNull(trailer),
      commodity: orNull(t(v.commodity ?? "")),
      pieceCount,
      palletCount,
      weightLbs,
      lengthFt,
      widthFt,
      heightIn,
      reeferSetTempF,
      reeferMinF,
      reeferMaxF,
      reeferMode: (reeferModeRaw === "" ? null : reeferModeRaw) as ReeferMode | null,
      hazmat: orNull(t(v.hazmat)),
      hazmatUnNumber: orNull(t(v.hazmatUnNumber ?? "")),
      hazmatPackingGroup: (pgRaw === "" ? null : pgRaw) as PackingGroup | null,
      hazmatEmergencyPhone: orNull(hazmatPhone),
      liftgate: v.liftgate === true,
      ramp: v.ramp === true,
      palletJack: v.palletJack === true,
      payTermsDays,
      notes: orNull(t(v.notes)),
      stopChangeReason: stopReasonRaw === "" ? null : (stopReasonRaw as StopChangeReason),
      stopChangeFee,
      stops,
      deal
    }
  };
}

export type ExistingStopPlan = {
  id: string;
  stopSequence: number;
  role: "pickup" | "delivery";
  address: string;
  earliest: Date | null;
  latest: Date | null;
  visited: boolean;
};

export type IncomingStopPlan = {
  id: string;
  role: "pickup" | "delivery";
  address: string;
  earliest: Date | null;
  latest: Date | null;
};

export type PlannedStop = IncomingStopPlan & {
  stopSequence: number;
  isNew: boolean;
  visited: boolean;
};

export type StopPlanResult =
  | {
      ok: true;
      planned: PlannedStop[];
      removedIds: string[];
      scheduleChanged: boolean;
      routeChanged: boolean;
      structureChanged: boolean;
    }
  | { ok: false; error: string };

const stopMinute = (d: Date | null) => (d ? Math.floor(d.getTime() / 60_000) : null);
const sameWindow = (a: Date | null, b: Date | null) => stopMinute(a) === stopMinute(b);
const isNewStopId = (id: string) => id === "" || id.startsWith("new:");

/**
 * Plan edits/additions/removals/reordering on a load's stops. Visited stops (`visited === true`, up to and including the last visited stop)
 * are strictly locked in order, place, time, and `stopSequence` so driver arrivals, waits, seals, PODs, and mobile `mergeStops` sequences
 * never shift or break. Unvisited stops after the last visited stop receive sequential numbers starting right after it.
 */
export function planStopChanges(existing: readonly ExistingStopPlan[], incoming: readonly IncomingStopPlan[]): StopPlanResult {
  if (incoming.length < 2) {
    return { ok: false, error: "A load needs at least two stops (pickup and delivery); the stops changed since you opened it." };
  }
  if (incoming.length > 10) {
    return { ok: false, error: "At most 10 stops per load." };
  }
  if (!incoming.some((s) => s.role === "pickup") || !incoming.some((s) => s.role === "delivery")) {
    return { ok: false, error: "A load needs at least one pickup and one delivery." };
  }
  const byId = new Map(existing.map((s) => [s.id, s]));
  const seenExisting = new Set<string>();
  for (const s of incoming) {
    if (isNewStopId(s.id)) continue;
    if (!byId.has(s.id) || seenExisting.has(s.id)) {
      return { ok: false, error: "The stops on this load changed since you opened it. Reload it and try again." };
    }
    seenExisting.add(s.id);
  }

  let lastVisitedIdx = -1;
  for (let i = 0; i < existing.length; i++) {
    if (existing[i]!.visited) lastVisitedIdx = i;
  }

  for (let i = 0; i <= lastVisitedIdx; i++) {
    const ex = existing[i]!;
    const inc = incoming[i];
    if (
      !inc ||
      inc.id !== ex.id ||
      inc.role !== ex.role ||
      inc.address !== ex.address ||
      !sameWindow(inc.earliest, ex.earliest) ||
      !sameWindow(inc.latest, ex.latest)
    ) {
      return { ok: false, error: "This load has started: visited stops cannot change where or when they are, or their order." };
    }
  }

  const baseSeq = lastVisitedIdx >= 0 ? existing[lastVisitedIdx]!.stopSequence : 0;
  const planned: PlannedStop[] = incoming.map((inc, i) => {
    const isVisitedPrefix = i <= lastVisitedIdx;
    const ex = isVisitedPrefix ? existing[i]! : null;
    const stopSequence = isVisitedPrefix ? ex!.stopSequence : baseSeq + (i - lastVisitedIdx);
    return {
      id: inc.id,
      role: inc.role,
      address: inc.address,
      earliest: inc.earliest,
      latest: inc.latest,
      stopSequence,
      isNew: isNewStopId(inc.id),
      visited: isVisitedPrefix
    };
  });

  const removedIds = existing.filter((ex) => !seenExisting.has(ex.id)).map((ex) => ex.id);
  const structureChanged =
    removedIds.length > 0 ||
    planned.some((p) => p.isNew) ||
    planned.length !== existing.length ||
    planned.some((p, i) => p.id !== existing[i]!.id || p.role !== existing[i]!.role);
  const routeChanged =
    structureChanged ||
    planned.some((p) => {
      const ex = byId.get(p.id);
      return !ex || ex.address !== p.address;
    });
  const scheduleChanged =
    routeChanged ||
    planned.some((p) => {
      const ex = byId.get(p.id);
      return !ex || !sameWindow(ex.earliest, p.earliest) || !sameWindow(ex.latest, p.latest);
    });

  return { ok: true, planned, removedIds, scheduleChanged, routeChanged, structureChanged };
}

type StoredLoad = {
  /** When the load was last changed: kept on the form as its version. */
  updatedAt?: Date | null;
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
  rateConNumber?: string | null;
  proNumber?: string | null;
  poNumber: string | null;
  bolNumber?: string | null;
  trailerType: string | null;
  commodity?: string | null;
  pieceCount?: number | null;
  palletCount?: number | null;
  weightLbs: number | null;
  lengthFt: unknown;
  widthFt: unknown;
  loadHeightIn: unknown;
  reeferSetTempF?: unknown;
  reeferMinF?: unknown;
  reeferMaxF?: unknown;
  reeferMode?: string | null;
  hazmatClass: string | null;
  hazmatUnNumber?: string | null;
  hazmatPackingGroup?: string | null;
  hazmatEmergencyPhone?: string | null;
  requiresLiftgate: boolean | null;
  requiresRamp: boolean | null;
  requiresPalletJack: boolean | null;
  payTermsDays: number | null;
  notes: string | null;
  stops: Array<{ id: string; stopRole: string | null; stopType: string; addressString: string; facilityName: string | null; timeWindowEarliest: Date | null; timeWindowLatest: Date | null; arrivedAt?: Date | null; referenceNumbers: unknown; contactName: string | null; contactPhone: string | null; stopNotes: string | null }>;
};

/** The form's values from a stored load, each stop's times on the clock at that stop (`zones` by stop id; a stop with none is on the carrier's clock). */
export function toEditValues(load: StoredLoad, zones: Record<string, string> = {}): LoadEditValues {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const local = (d: Date | null, zone?: string) => (d ? toCentralLocal(d.getTime(), zone) : "");
  /** A stored decimal as the figure to show: no trailing zeros, blank when there is none or it is zero. */
  const money = (v: unknown) => {
    if (v == null) return "";
    const n = Number(String(v));
    return Number.isFinite(n) && n !== 0 ? String(n) : "";
  };
  const temp = (v: unknown) => {
    if (v == null) return "";
    const n = Number(String(v));
    return Number.isFinite(n) ? String(n) : "";
  };
  return {
    version: load.updatedAt ? String(load.updatedAt.getTime()) : undefined,
    brokerName: s(load.brokerName),
    brokerMc: s(load.brokerMcNumber),
    brokerPhone: s(load.brokerPhone),
    brokerEmail: s(load.brokerEmail),
    loadNumber: s(load.loadNumber),
    rateConNumber: s(load.rateConNumber),
    proNumber: s(load.proNumber),
    poNumber: s(load.poNumber),
    bolNumber: s(load.bolNumber),
    trailer: s(load.trailerType),
    commodity: s(load.commodity),
    pieceCount: s(load.pieceCount),
    palletCount: s(load.palletCount),
    weightLbs: s(load.weightLbs),
    lengthFt: s(load.lengthFt),
    widthFt: s(load.widthFt),
    heightIn: s(load.loadHeightIn),
    reeferSetTempF: temp(load.reeferSetTempF),
    reeferMinF: temp(load.reeferMinF),
    reeferMaxF: temp(load.reeferMaxF),
    reeferMode: s(load.reeferMode),
    hazmat: s(load.hazmatClass),
    hazmatUnNumber: s(load.hazmatUnNumber),
    hazmatPackingGroup: s(load.hazmatPackingGroup),
    hazmatEmergencyPhone: s(load.hazmatEmergencyPhone),
    liftgate: load.requiresLiftgate === true,
    ramp: load.requiresRamp === true,
    palletJack: load.requiresPalletJack === true,
    payTermsDays: s(load.payTermsDays),
    notes: s(load.notes),
    stopChangeReason: "",
    stopChangeFee: "",
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
      role: roleOfStop(x),
      address: x.addressString,
      facility: s(x.facilityName),
      earliest: local(x.timeWindowEarliest, zones[x.id]),
      latest: local(x.timeWindowLatest, zones[x.id]),
      zone: zones[x.id] ?? null,
      refs: Array.isArray(x.referenceNumbers) ? (x.referenceNumbers as unknown[]).map(String).join(", ") : "",
      contactName: s(x.contactName),
      contactPhone: s(x.contactPhone),
      notes: s(x.stopNotes),
      visited: x.arrivedAt != null
    }))
  };
}
