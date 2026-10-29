// VENDORED from TrueLane lib/domain/fieldRelevance.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Vehicle-aware field relevance — the first step of the v1 owner-op UI simplification.
 *
 * Truck driving is the #1 job for HS grads, not analysts: a Mack truck driver should never see a
 * cargo-van field, and vice-versa. This module maps a vehicle's `type` to a freight MODE, then a
 * mode to a per-field visibility (`show` | `hide` | `advanced`). The UI reads this to render only
 * the relevant fields, tuck the rest under "More fields" (`advanced`), and never show `hide`.
 *
 * This module is SEMANTIC only — no colors, no copy, and no coupling to form-field names or the
 * data layer. `CalculatorField` is a stable vocabulary the UI maps to concrete inputs; the data
 * mapper is responsible for forcing hidden fields to safe defaults so math + saved rows never break.
 *
 * Safety default: any (mode, field) not listed resolves to `show`. A field can only be hidden or
 * demoted by an explicit entry, so a new field is visible until someone deliberately gates it.
 *
 * Field relevance keys off VEHICLE TYPE ONLY in v1 (the user is fixed = owner-operator). The
 * role/driver axis (Phase 2 fleets, where drivers never see price) is intentionally not modeled yet.
 */

import { ALL_VEHICLE_CATEGORIES, type VehicleCategory } from '@/truelane/constants/vehicleData';

/** The four freight modes the seven vehicle types collapse into. */
export type FreightMode = 'van_expedite' | 'hotshot' | 'medium_box' | 'heavy_tl';

/** `show` = render inline · `advanced` = tuck under "More fields" · `hide` = never render. */
export type FieldVisibility = 'show' | 'hide' | 'advanced';

/**
 * Stable vocabulary of gate-able calculator fields. Core fields shown in every mode (route, quoted
 * revenue, fuel surcharge, market benchmark, notes, payment/factoring, pay terms, lead time,
 * backhaul, estimated hours, weight, broker name) are intentionally NOT listed here — they resolve
 * to `show` by default. Only fields whose relevance varies by mode appear below.
 */
export type CalculatorField =
  | 'detention' // dock wait / detention time
  | 'towedTrailer' // towing a trailer? + its cost-per-mile (hotshot-defining)
  | 'rpmOverride' // manual all-in RPM override (power-user escape hatch)
  | 'insuranceRider' // per-load insurance rider ($)
  | 'liftgate' // liftgate accessorial
  | 'ramp' // ramp accessorial (car haul / step)
  | 'palletJack' // pallet jack accessorial
  | 'dimensions' // freight length / width (ft)
  | 'hazmatClass' // hazmat classification
  | 'trailerType' // trailer/equipment class (trailer-pulling modes only)
  | 'loadHeight' // load height (open-deck trailers — over-height permit trigger)
  | 'permitEscort'; // oversize permit + escort cost ($) — no screen renders it since 2026-09-24 (moved to Expenses)

/**
 * Overrides from the `show` default, per mode. Read via `fieldVisibility` — never index directly,
 * so the `show` fallback always applies. Every mode-varying field is listed explicitly in each mode
 * (even where it equals a value another mode differs on) to keep this readable as a matrix.
 */
export const FIELD_RELEVANCE: Record<FreightMode, Partial<Record<CalculatorField, FieldVisibility>>> = {
  // Cargo / sprinter / passenger van: small parcel & expedite. Fixed box, no trailer, rarely hazmat.
  van_expedite: {
    detention: 'advanced',
    towedTrailer: 'hide',
    rpmOverride: 'advanced',
    insuranceRider: 'advanced',
    liftgate: 'advanced',
    ramp: 'advanced',
    palletJack: 'show',
    dimensions: 'hide',
    hazmatClass: 'hide',
    trailerType: 'hide',
    loadHeight: 'hide',
    permitEscort: 'hide',
  },
  // Pickup: hotshot / light. The trailer IS the job; ramps for car haul; dims matter; hazmat rare.
  hotshot: {
    detention: 'advanced',
    towedTrailer: 'show',
    rpmOverride: 'advanced',
    insuranceRider: 'advanced',
    liftgate: 'hide',
    ramp: 'show',
    palletJack: 'hide',
    dimensions: 'show',
    hazmatClass: 'advanced',
    trailerType: 'show',
    loadHeight: 'show',
    permitEscort: 'show',
  },
  // Box / medium-duty: LTL & final-mile. Docks, liftgates, pallet jacks, dims all in play.
  medium_box: {
    detention: 'show',
    towedTrailer: 'hide',
    rpmOverride: 'advanced',
    insuranceRider: 'advanced',
    liftgate: 'show',
    ramp: 'show',
    palletJack: 'show',
    dimensions: 'show',
    hazmatClass: 'advanced',
    trailerType: 'hide',
    loadHeight: 'hide',
    permitEscort: 'hide',
  },
  // Heavy-duty / truckload (OTR): trailer/equipment class, oversize permits, high insurance, hazmat.
  heavy_tl: {
    detention: 'show',
    towedTrailer: 'hide',
    rpmOverride: 'advanced',
    insuranceRider: 'show',
    liftgate: 'hide',
    ramp: 'hide',
    palletJack: 'hide',
    dimensions: 'advanced',
    hazmatClass: 'show',
    trailerType: 'show',
    loadHeight: 'show',
    permitEscort: 'show',
  },
};

/** Runtime guard: is this arbitrary string one of the known vehicle categories? */
export function isVehicleCategory(type: string | null | undefined): type is VehicleCategory {
  return type != null && (ALL_VEHICLE_CATEGORIES as readonly string[]).includes(type);
}

/** Collapse a vehicle `type` (7) into its freight mode (4). */
export function vehicleTypeToMode(type: VehicleCategory): FreightMode {
  switch (type) {
    case 'cargo_van':
    case 'sprinter':
    case 'passenger_van':
      return 'van_expedite';
    case 'pickup':
      return 'hotshot';
    case 'box_truck':
    case 'medium_duty':
      return 'medium_box';
    case 'heavy_duty':
      return 'heavy_tl';
  }
}

/** Visibility of a field in a given mode. Anything unlisted resolves to `show` (safe default). */
export function fieldVisibility(mode: FreightMode, field: CalculatorField): FieldVisibility {
  return FIELD_RELEVANCE[mode][field] ?? 'show';
}

/**
 * Visibility of a field for a vehicle. Accepts an arbitrary string (the app carries vehicle type as
 * `string | null`): when the type is null/absent or not a recognized category (no active vehicle,
 * legacy row, unexpected value), everything resolves to `show` — we never hide a field just because
 * we can't classify the truck.
 */
export function fieldVisibilityForVehicle(
  type: string | null | undefined,
  field: CalculatorField
): FieldVisibility {
  if (!isVehicleCategory(type)) return 'show';
  return fieldVisibility(vehicleTypeToMode(type), field);
}

/** True when the field renders at all (inline or under "More fields") — i.e. not `hide`. */
export function isFieldRendered(type: string | null | undefined, field: CalculatorField): boolean {
  return fieldVisibilityForVehicle(type, field) !== 'hide';
}

/** True when the field is demoted under "More fields" for this vehicle. */
export function isFieldAdvanced(type: string | null | undefined, field: CalculatorField): boolean {
  return fieldVisibilityForVehicle(type, field) === 'advanced';
}

/**
 * True for the commercial-truck freight modes (hotshot / medium_box / heavy_tl) — the vehicles for
 * which passenger-car mapping estimates are unsafe (low bridges, weight/height limits, truck bans),
 * so the route section should warn the driver to verify against commercial navigation (10o). Vans,
 * sprinters and passenger vans (van_expedite) route fine as automobiles, so no advisory.
 */
export function needsCommercialRouteAdvisory(type: string | null | undefined): boolean {
  if (!isVehicleCategory(type)) return false;
  const mode = vehicleTypeToMode(type);
  return mode === 'hotshot' || mode === 'medium_box' || mode === 'heavy_tl';
}
