import { getMakes, getModels, getSpecs, getYears } from "@/truelane/constants/vehicleData";
import { canonicalTruckType, type TruckValues } from "./fleet-forms";

/**
 * Picking a truck by make, model and year, and the specs that follow from it: the type, miles per gallon, payload and cargo dimensions. The
 * dataset is the phone's own (vendored), so a Ford Transit 250 is the same truck here as on a driver's phone. A pick fills a field only when it
 * is blank or still holds what the previous pick put there, so a number someone typed by hand is never overwritten by choosing another model.
 * Pure.
 */
export type SpecKey = "type" | "mpg" | "payloadLbs" | "maxLengthFt" | "maxWidthFt" | "maxHeightIn";
export const SPEC_KEYS: readonly SpecKey[] = ["type", "mpg", "payloadLbs", "maxLengthFt", "maxWidthFt", "maxHeightIn"];
export type SpecFill = Record<SpecKey, string>;

export const truckMakes = (): string[] => getMakes();
export const truckModels = (make: string): string[] => getModels(make).map((m) => m.model);
export const truckYears = (make: string, model: string): number[] => getYears(make, model);

/** The specs the dataset holds for a make and model, as the strings the form shows; null when it has none (an unknown or custom vehicle). */
export function specFill(make: string, model: string): SpecFill | null {
  const s = getSpecs(make, model);
  if (!s || [s.mpg, s.payloadLbs, s.maxLengthFt, s.maxWidthFt, s.maxHeightIn].every((x) => x == null)) return null;
  const text = (n: number | null) => (n == null ? "" : String(n));
  return { type: canonicalTruckType(s.type) ?? "", mpg: text(s.mpg), payloadLbs: text(s.payloadLbs), maxLengthFt: text(s.maxLengthFt), maxWidthFt: text(s.maxWidthFt), maxHeightIn: text(s.maxHeightIn) };
}

type PickFields = Pick<TruckValues, SpecKey | "make" | "model" | "year">;

/** Take away what the previous pick filled in and nobody changed, so it can be replaced (or left empty) rather than kept by accident. */
function withoutPrevFill<T extends PickFields>(v: T, prev: SpecFill | null): T {
  if (!prev) return v;
  const out = { ...v };
  for (const k of SPEC_KEYS) if (out[k] === prev[k]) out[k] = "";
  return out;
}

/** A make was chosen: its models replace the old ones, so the model and year clear, and so does whatever the old model had filled in. */
export function pickMake<T extends PickFields>(values: T, make: string): T {
  if (make === values.make) return values;
  const cleared = withoutPrevFill(values, specFill(values.make, values.model));
  return { ...cleared, make, model: "", year: "" };
}

/** A model was chosen: the year clears, and each spec field the dataset knows is filled when it is blank or still the old model's. */
export function pickModel<T extends PickFields>(values: T, model: string): T {
  if (model === values.model) return values;
  const cleared = withoutPrevFill(values, specFill(values.make, values.model));
  const next = specFill(cleared.make, model);
  const out = { ...cleared, model, year: "" };
  if (!next) return out;
  for (const k of SPEC_KEYS) if (out[k] === "" && next[k] !== "") out[k] = next[k];
  return out;
}

/** The choices for a picker, with the stored value kept when it is not in the dataset (a truck entered by hand, or an older record). */
export const withCurrent = <T extends string | number>(list: readonly T[], current: T | ""): T[] => (current === "" || list.includes(current as T) ? [...list] : [current as T, ...list]);
