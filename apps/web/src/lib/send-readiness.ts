import { getStartTripMissing, START_TRIP_REQUIREMENT_LABEL, trailerRequiredForVehicle, type StartTripRequirement } from "@/truelane/lib/loadReadiness";

/**
 * What a load still lacks before it goes to a driver. The phone will not start a trip without weight, a load number, a pickup number and
 * (for a truck that pulls a trailer) the trailer, so the same list is what a driver would stop on; the desk adds the two times, because a load
 * with no times cannot be planned or chased. Advisory: the dispatcher can send anyway, and the audit entry then says what was missing.
 */
export type SendGap = { key: StartTripRequirement | "pickupTime" | "deliveryTime"; label: string };

export type SendReadinessInput = {
  weightLbs: number | null;
  loadNumber: string | null;
  /** Load-level pickup numbers plus every pickup stop's reference numbers. */
  pickupRefs: readonly string[];
  trailerType: string | null;
  vehicleType: string | null;
  pickupTime: Date | null;
  deliveryTime: Date | null;
};

export function sendReadiness(i: SendReadinessInput): SendGap[] {
  const missing = getStartTripMissing({
    weightLbs: i.weightLbs,
    loadNumber: i.loadNumber,
    pickupRefs: i.pickupRefs,
    trailerType: i.trailerType,
    trailerRequired: trailerRequiredForVehicle(i.vehicleType)
  });
  const gaps: SendGap[] = missing.map((key) => ({ key, label: START_TRIP_REQUIREMENT_LABEL[key] }));
  if (i.pickupTime == null) gaps.push({ key: "pickupTime", label: "pickup time" });
  if (i.deliveryTime == null) gaps.push({ key: "deliveryTime", label: "delivery time" });
  return gaps;
}

/** The gaps in a sentence: "weight and pickup number". */
export function gapsPhrase(gaps: readonly SendGap[]): string {
  const names = gaps.map((g) => g.label.replace(/ \(.*\)$/, ""));
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Strings out of a Json column that holds a list. */
export function refList(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}
