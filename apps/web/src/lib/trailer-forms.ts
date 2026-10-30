import { TRAILER_TYPES } from "@/truelane/constants/trailerData";
import { TERMINAL_MAX_LENGTH } from "./terminal";
import { endOfCentralDay } from "./fleet-forms";
import { TRAILER_STATUSES } from "./trailer-clearance";

/** The Add trailer / Edit trailer form: values as typed, and the check that reads them. Pure; shared by the form, the CSV import and the server. */
type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export const OWNERSHIPS = [
  { key: "owned", label: "Owned" },
  { key: "leased", label: "Leased" },
  { key: "customer", label: "Customer's" },
  { key: "pool", label: "Pool" }
] as const;

export type TrailerValues = {
  number: string;
  type: string;
  plate: string;
  plateState: string;
  vin: string;
  ownership: string;
  lengthFt: string;
  widthIn: string;
  tareLbs: string;
  maxPayloadLbs: string;
  axles: string;
  hasLiftgate: string;
  hasETrack: string;
  status: string;
  terminal: string;
  location: string;
  /** "2027-03-31", the last day it is good. */
  registrationExpiry: string;
  inspectionExpiry: string;
  notes: string;
};

export const BLANK_TRAILER: TrailerValues = { number: "", type: "", plate: "", plateState: "", vin: "", ownership: "owned", lengthFt: "", widthIn: "", tareLbs: "", maxPayloadLbs: "", axles: "", hasLiftgate: "", hasETrack: "", status: "available", terminal: "", location: "", registrationExpiry: "", inspectionExpiry: "", notes: "" };

export type TrailerNumbers = { lengthFt: number | null; widthIn: number | null; tareLbs: number | null; maxPayloadLbs: number | null; axles: number | null; registrationExpiry: Date | null; inspectionExpiry: Date | null };
export type TrailerCheck = { ok: true; value: TrailerValues; numbers: TrailerNumbers } | { ok: false; errors: Partial<Record<keyof TrailerValues, string>> };

export function validateTrailer(input: Raw): TrailerCheck {
  const v: TrailerValues = {
    number: str(input.number).replace(/\s+/g, " "),
    type: str(input.type),
    plate: str(input.plate).toUpperCase(),
    plateState: str(input.plateState).toUpperCase(),
    vin: str(input.vin).toUpperCase(),
    ownership: str(input.ownership) || "owned",
    lengthFt: str(input.lengthFt),
    widthIn: str(input.widthIn),
    tareLbs: str(input.tareLbs).replace(/,/g, ""),
    maxPayloadLbs: str(input.maxPayloadLbs).replace(/,/g, ""),
    axles: str(input.axles),
    hasLiftgate: str(input.hasLiftgate) === "yes" ? "yes" : "",
    hasETrack: str(input.hasETrack) === "yes" ? "yes" : "",
    status: str(input.status) || "available",
    terminal: str(input.terminal).replace(/\s+/g, " "),
    location: str(input.location),
    registrationExpiry: str(input.registrationExpiry),
    inspectionExpiry: str(input.inspectionExpiry),
    notes: str(input.notes)
  };
  const errors: Partial<Record<keyof TrailerValues, string>> = {};
  if (v.number.length < 1) errors.number = "Give the trailer a number, for example T-2041.";
  else if (v.number.length > 30) errors.number = "That number is too long.";
  if (v.type && !TRAILER_TYPES.some((t) => t.value === v.type)) errors.type = "Pick a type from the list.";
  if (v.plate.length > 15) errors.plate = "That plate is too long.";
  if (v.plateState && !/^[A-Z]{2}$/.test(v.plateState)) errors.plateState = "Two letters, for example TX.";
  if (v.vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(v.vin)) errors.vin = "A VIN is 17 letters and digits (no I, O or Q).";
  if (!OWNERSHIPS.some((o) => o.key === v.ownership)) errors.ownership = "Owned, leased, a customer's or pool.";
  if (!TRAILER_STATUSES.some((s) => s.key === v.status)) errors.status = "Pick a status from the list.";
  if (v.terminal.length > TERMINAL_MAX_LENGTH) errors.terminal = "That terminal name is too long.";
  if (v.location.length > 80) errors.location = "That location is too long.";
  if (v.notes.length > 1000) errors.notes = "Notes are 1,000 characters at most.";
  const number = (key: "lengthFt" | "widthIn" | "tareLbs" | "maxPayloadLbs" | "axles", min: number, max: number, whole: boolean, message: string): number | null => {
    if (!v[key]) return null;
    const n = Number(v[key]);
    if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
      errors[key] = message;
      return null;
    }
    return n;
  };
  const numbers: TrailerNumbers = {
    lengthFt: number("lengthFt", 1, 60, false, "Length in feet, 1 to 60."),
    widthIn: number("widthIn", 48, 120, false, "Width in inches, 48 to 120."),
    tareLbs: number("tareLbs", 1, 40000, true, "Empty weight in whole pounds, 1 to 40,000."),
    maxPayloadLbs: number("maxPayloadLbs", 1, 80000, true, "Payload in whole pounds, 1 to 80,000."),
    axles: number("axles", 1, 6, true, "Axles, 1 to 6."),
    registrationExpiry: null,
    inspectionExpiry: null
  };
  for (const key of ["registrationExpiry", "inspectionExpiry"] as const) {
    if (!v[key]) continue;
    const d = endOfCentralDay(v[key]);
    if (!d) errors[key] = "A real date.";
    else numbers[key] = d;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: v, numbers };
}
